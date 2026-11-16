/**
 * 播放缓存：整曲先落到本地再交给播放器，所以播放与下载不并发（单倍流量），之后离线也能直接播本地文件。
 * 只管缓存文件与索引；用户主动下载走 downloader，"已下载"标记走 mediaExtra，互不掺和。
 */
import {
    emptyFunction,
    localPluginPlatform,
    supportLocalMediaType,
} from "@/constants/commonConst";
import pathConst from "@/constants/pathConst";
import Config from "@/core/appConfig";
import Toast from "@/utils/toast";
import { addFileScheme, escapeCharacter, mkdirR } from "@/utils/fileUtils";
import getUrlExt from "@/utils/getUrlExt";
import getOrCreateMMKV from "@/utils/getOrCreateMMKV";
import { safeParse } from "@/utils/jsonUtil";
import { errorLog } from "@/utils/log";
import network from "@/utils/network";
import { copyFile, downloadFile, exists, unlink } from "react-native-fs";
import { pickEvictionTargets, type ICacheEntry } from "./playCacheEviction";

const store = getOrCreateMMKV("cache.PlayCache", true);

/** RNFS 运行时会给 promise 挂 cancel，类型声明里没有 */
type IDownloadTask = ReturnType<typeof downloadFile>["promise"] & {
    cancel: () => void;
};

/** 同一时刻只保留用户正在等的这一首：切歌就取消上一首的下载，免得白占带宽 */
let pendingDownload: {
    key: string;
    promise: Promise<{ url: string } | null>;
    task: IDownloadTask;
} | null = null;

function cacheKey(mediaItem: ICommon.IMediaBase, quality: IMusic.IQualityKey) {
    return `${mediaItem.platform}@${mediaItem.id}@${quality}`;
}

function readEntry(key: string): ICacheEntry | null {
    return safeParse<ICacheEntry>(store.getString(key));
}

function allEntries(): Array<[string, ICacheEntry]> {
    const entries: Array<[string, ICacheEntry]> = [];
    for (const key of store.getAllKeys()) {
        const entry = readEntry(key);
        if (entry) {
            entries.push([key, entry]);
        }
    }
    return entries;
}

/** 后缀识别不出可播放格式时按 mp3 落地，口径同 downloader */
function getExtension(url: string) {
    const ext = getUrlExt(url);
    return ext && supportLocalMediaType.includes(ext) ? ext : ".mp3";
}

/** .part 是下载中的临时文件，避免半截文件被当成整曲 */
function cachePathOf(
    mediaItem: IMusic.IMusicItem,
    quality: IMusic.IQualityKey,
    url: string,
) {
    const targetPath = `${pathConst.playCachePath}${escapeCharacter(
        mediaItem.platform,
    )}@${escapeCharacter(`${mediaItem.id}`)}@${quality}${getExtension(
        url,
    )}`.slice(0, 200);
    return { targetPath, tmpPath: `${targetPath}.part` };
}

/** 命中缓存则返回可直接喂给播放器的本地源，并刷新 LRU 时间 */
export async function resolveCacheSource(
    mediaItem: ICommon.IMediaBase | null,
    qualityOrder: IMusic.IQualityKey[],
): Promise<{ url: string; quality: IMusic.IQualityKey } | null> {
    if (!mediaItem?.platform || !mediaItem.id) {
        return null;
    }

    for (const quality of qualityOrder) {
        const key = cacheKey(mediaItem, quality);
        const entry = readEntry(key);
        if (!entry) {
            continue;
        }
        if (!(await exists(entry.path))) {
            // 缓存文件可能被系统或设置页清掉，索引就地自愈
            store.delete(key);
            continue;
        }
        store.set(
            key,
            JSON.stringify({ ...entry, lastAccess: Date.now() } as ICacheEntry),
        );
        return { url: addFileScheme(entry.path), quality };
    }
    return null;
}

async function evict() {
    const limit = Config.getConfig("basic.maxCacheSize") ?? 1024 * 1024 * 512;
    for (const key of pickEvictionTargets(allEntries(), limit)) {
        const entry = readEntry(key);
        store.delete(key);
        if (entry) {
            await unlink(entry.path).catch(emptyFunction);
        }
    }
}

async function finishDownload(
    musicItem: IMusic.IMusicItem,
    quality: IMusic.IQualityKey,
    key: string,
    targetPath: string,
    tmpPath: string,
    task: IDownloadTask,
): Promise<{ url: string } | null> {
    try {
        const res = await task;
        // 签名过期或被限流时返回的是错误页，落进缓存就是永久坏数据
        if (
            res.statusCode < 200 ||
            res.statusCode >= 300 ||
            !res.bytesWritten
        ) {
            return null;
        }
        await copyFile(tmpPath, targetPath);
        store.set(
            key,
            JSON.stringify({
                path: targetPath,
                size: res.bytesWritten,
                lastAccess: Date.now(),
            } as ICacheEntry),
        );
        await evict();
        // 上限调得很小时刚落的这条可能就被淘汰了，此时回退远程源
        return readEntry(key) ? { url: addFileScheme(targetPath) } : null;
    } catch (e: any) {
        errorLog("播放缓存失败", {
            item: {
                id: musicItem.id,
                platform: musicItem.platform,
                quality,
            },
            reason: e?.message ?? e,
        });
        return null;
    } finally {
        if (pendingDownload?.task === task) {
            pendingDownload = null;
        }
        await unlink(tmpPath).catch(emptyFunction);
    }
}

/**
 * 整曲下到本地并返回本地源。本地音乐、hls 分片流、离线都不可缓存，
 * 下载失败也一律返回 null，由调用方回退远程源——缓存不能让歌播不出来。
 */
export async function cacheMusic(
    musicItem: IMusic.IMusicItem,
    quality: IMusic.IQualityKey,
    source: IPlugin.IMediaSourceResult | null,
): Promise<{ url: string } | null> {
    const url = source?.url;
    if (
        !url?.startsWith("http") ||
        musicItem.platform === localPluginPlatform ||
        getUrlExt(url) === ".m3u8" ||
        network.isOffline
    ) {
        return null;
    }

    const key = cacheKey(musicItem, quality);
    const cached = readEntry(key);
    if (cached) {
        return { url: addFileScheme(cached.path) };
    }
    if (pendingDownload?.key === key) {
        return pendingDownload.promise;
    }
    pendingDownload?.task.cancel();

    Toast.warn("缓存中，稍后播放");
    await mkdirR(pathConst.playCachePath);
    const { targetPath, tmpPath } = cachePathOf(musicItem, quality, url);
    const { promise } = downloadFile({
        fromUrl: url,
        toFile: tmpPath,
        headers: source?.headers,
    });
    const task = promise as IDownloadTask;
    const result = finishDownload(
        musicItem,
        quality,
        key,
        targetPath,
        tmpPath,
        task,
    );
    pendingDownload = { key, promise: result, task };
    return result;
}

/** 清空索引；缓存文件由 clearCache("music") 负责，两者必须一起清，否则残留索引会让缓存误判为已完成 */
export function clearPlayCacheIndex() {
    pendingDownload?.task.cancel();
    pendingDownload = null;
    store.clearAll();
}
