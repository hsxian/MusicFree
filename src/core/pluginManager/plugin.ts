import {
    CacheControl,
    internalSerializeKey,
    localPluginPlatform,
} from "@/constants/commonConst";
import pathConst from "@/constants/pathConst";
import Mp3Util from "@/native/mp3Util";
import Base64 from "@/utils/base64";
import delay from "@/utils/delay";
import { addFileScheme, getFileName } from "@/utils/fileUtils";
import { getMediaExtraProperty, patchMediaExtra } from "@/utils/mediaExtra";
import { getLocalPath, isSameMediaItem, resetMediaItem } from "@/utils/mediaUtils";
import notImplementedFunction from "@/utils/notImplementedFunction.ts";
import axios from "axios";
import bigInt from "big-integer";
import * as cheerio from "cheerio";
import { satisfies } from "compare-versions";
import CryptoJs from "crypto-js";
import dayjs from "dayjs";
import he from "he";
import { produce } from "immer";
import { nanoid } from "nanoid";
import objectPath from "object-path";
import qs from "qs";
import { default as DeviceInfo, default as deviceInfoModule } from "react-native-device-info";
import RNFS, { exists, readFile, stat, writeFile } from "react-native-fs";
import { URL } from "react-native-url-polyfill";
import * as webdav from "webdav";
import { devLog, errorLog, trace } from "../../utils/log";
import Network from "../../utils/network";
import MediaCache from "../mediaCache";
import _internalPluginMeta from "./meta";
import { IPluginManager } from "@/types/core/pluginManager";


axios.defaults.timeout = 2000;
axios.interceptors.response.use((response) => {
    // 统一setcookie格式，nodejs环境是数组，移动端环境都放在第一个元素
    const setCookie = response.headers["set-cookie"];
    if(setCookie && setCookie.length === 1) {
        const splitedCookie = setCookie[0].split(",");
        response.headers["set-cookie"] = splitedCookie;
        response.headers["x-set-cookie"] = setCookie;
    }

    return response;
});

const sha256 = CryptoJs.SHA256;

const deprecatedCookieManager = {
    get: notImplementedFunction,
    set: notImplementedFunction,
    flush: notImplementedFunction,
};

const packages: Record<string, any> = {
    cheerio,
    "crypto-js": CryptoJs,
    axios,
    dayjs,
    "big-integer": bigInt,
    qs,
    he,
    "@react-native-cookies/cookies": deprecatedCookieManager,
    webdav,
};

const _require = (packageName: string) => {
    let pkg = packages[packageName];
    pkg.default = pkg;
    return pkg;
};

const _consoleBind = function (
    method: "log" | "error" | "info" | "warn",
    ...args: any
) {
    const fn = console[method];
    if (fn) {
        fn(...args);
        devLog(method, ...args);
    }
};

const _console = {
    log: _consoleBind.bind(null, "log"),
    warn: _consoleBind.bind(null, "warn"),
    info: _consoleBind.bind(null, "info"),
    error: _consoleBind.bind(null, "error"),
};

const appVersion = deviceInfoModule.getVersion();

function formatAuthUrl(url: string) {
    const urlObj = new URL(url);

    try {
        if (urlObj.username && urlObj.password) {
            const auth = `Basic ${Base64.btoa(
                `${decodeURIComponent(urlObj.username)}:${decodeURIComponent(
                    urlObj.password,
                )}`,
            )}`;
            urlObj.username = "";
            urlObj.password = "";

            return {
                url: urlObj.toString(),
                auth,
            };
        }
    } catch (e) {
        return {
            url,
        };
    }
    return {
        url,
    };
}

export enum PluginState {
    // 初始化
    Initializing,
    // 加载中
    Loading,
    // 已加载
    Mounted,
    // 出现错误
    Error
}

export enum PluginErrorReason {
    // 版本不匹配
    VersionNotMatch,
    // 无法解析
    CannotParse,
}


export interface ILazyProps {
    name: string;
    hash: string;
    path: string;
    supportedMethods?: string[];
    loadFuncCode?: () => Promise<string>;
    instance?: IPlugin.IPluginDefine;
}

class PluginMethodsWrapper implements IPlugin.IPluginInstanceMethods {
    private plugin: Plugin;
    private ensurePluginIsMounted: () => Promise<void>;

    constructor(plugin: Plugin, ensurePluginIsMounted: () => Promise<void>) {
        this.plugin = plugin;
        this.ensurePluginIsMounted = ensurePluginIsMounted;
    }


    /** 搜索 */
    async search<T extends ICommon.SupportMediaType>(
        query: string,
        page: number,
        type: T,
    ): Promise<IPlugin.ISearchResult<T>> {
        await this.ensurePluginIsMounted();
        if (!this.plugin.instance.search) {
            return {
                isEnd: true,
                data: [],
            };
        }

        const result =
            (await this.plugin.instance.search(query, page, type)) ?? {};
        if (Array.isArray(result.data)) {
            result.data.forEach(_ => {
                resetMediaItem(_, this.plugin.name);
            });
            return {
                isEnd: result.isEnd ?? true,
                data: result.data,
            };
        }
        return {
            isEnd: true,
            data: [],
        };
    }

    /** 获取真实源 */
    async getMediaSource(
        musicItem: IMusic.IMusicItemBase,
        quality: IMusic.IQualityKey = "standard",
        retryCount = 1,
        notUpdateCache = false,
    ): Promise<IPlugin.IMediaSourceResult | null> {
        await this.ensurePluginIsMounted();
        // 1. 本地搜索 其实直接读mediameta就好了
        const localPathInMediaExtra = getMediaExtraProperty(musicItem, "localPath");
        const localPath = getLocalPath(musicItem);
        if (localPath && (await exists(localPath))) {
            trace("本地播放", localPath);
            if (localPathInMediaExtra !== localPath) {
                // 修正一下本地数据
                patchMediaExtra(musicItem, {
                    localPath,
                });

            }
            return {
                url: addFileScheme(localPath),
            };
        } else if (localPathInMediaExtra) {
            patchMediaExtra(musicItem, {
                localPath: undefined,
            });
        }

        if (musicItem.platform === localPluginPlatform) {
            throw new Error("本地音乐不存在");
        }
        // 2. 缓存播放
        const mediaCache = MediaCache.getMediaCache(
            musicItem,
        ) as IMusic.IMusicItem | null;
        const pluginCacheControl =
            this.plugin.instance.cacheControl ?? "no-cache";
        if (
            mediaCache &&
            mediaCache?.source?.[quality]?.url &&
            (pluginCacheControl === CacheControl.Cache ||
                (pluginCacheControl === CacheControl.NoCache &&
                    Network.isOffline))
        ) {
            trace("播放", "缓存播放");
            const qualityInfo = mediaCache.source[quality];
            return {
                url: qualityInfo!.url,
                headers: mediaCache.headers,
                userAgent:
                    mediaCache.userAgent ?? mediaCache.headers?.["user-agent"],
            };
        }
        // 3. 替代插件
        const alternativePlugin = Plugin.pluginManager?.getAlternativePlugin(this.plugin) as Plugin | null;
        const parserPlugin = alternativePlugin?.instance?.getMediaSource ? alternativePlugin : this.plugin;

        if (alternativePlugin) {
            devLog("info", "设置了替代插件，实际使用的插件为", parserPlugin.name);
        }

        // 4. 插件解析
        if (!parserPlugin.instance.getMediaSource) {
            const { url, auth } = formatAuthUrl(
                musicItem?.qualities?.[quality]?.url ?? musicItem.url,
            );
            return {
                url: url,
                headers: auth
                    ? {
                        Authorization: auth,
                    }
                    : undefined,
            };
        }
        try {
            /**
             * 入参盖主键：插件内部常按自己的 platform 分支，曲目里可能是别名或旧写法。
             * `_src` 只由插件自己的 search 产出，键是通道名（qq / kuwo / kugou…）、值是
             * {mid, mediaMid, vid, vip} 这类平台私有字段，外面猜不出来，所以只能让插件自己搜一次补回来。
             */
            const pluginInput = resetMediaItem(musicItem, this.plugin.name, true);
            const knownSrc =
                (pluginInput as any)._src ??
                getMediaExtraProperty(musicItem, "src");
            if (knownSrc) {
                (pluginInput as any)._src = knownSrc;
            }
            const fetchSource = () =>
                parserPlugin.instance.getMediaSource!(pluginInput, quality);
            let source = (await fetchSource()) ?? null;
            let recovered: IMusic.IMusicItemBase | null = null;
            if (!source?.url) {
                /**
                 * 取不到源就用插件自己的产物重建这首歌再试一次：老曲目（导入/备份）要么没有
                 * `_src`，要么留着换插件前那份，插件都直接返回空。重建出来的就是插件自己
                 * search 过的那份，和"重新搜一遍再点播"完全等价。
                 */
                recovered = await this.recoverItem(pluginInput);
                if (recovered) {
                    const src = (recovered as any)._src;
                    if (src) {
                        patchMediaExtra(musicItem, { src });
                    }
                    source =
                        (await parserPlugin.instance.getMediaSource!(
                            resetMediaItem(recovered, this.plugin.name, true),
                            quality,
                        )) ?? null;
                }
            }
            const url = source?.url ?? musicItem?.qualities?.[quality]?.url;
            const headers = source?.headers;
            if (!url) {
                /** 失败时把关键信息一并留下，否则只有一句插件自己的报错，没法定位是哪首歌、缺什么 */
                errorLog("取源失败", {
                    platform: pluginInput.platform,
                    id: pluginInput.id,
                    title: musicItem.title,
                    artist: musicItem.artist,
                    src: (pluginInput as any)._src
                        ? Object.keys((pluginInput as any)._src)
                        : null,
                    recovered: !!recovered,
                });
                throw new Error("NOT RETRY");
            }
            trace("播放", "插件播放");
            const result = {
                url,
                headers,
                userAgent: headers?.["user-agent"],
            } as IPlugin.IMediaSourceResult;
            const authFormattedResult = formatAuthUrl(result.url!);
            if (authFormattedResult.auth) {
                result.url = authFormattedResult.url;
                result.headers = {
                    ...(result.headers ?? {}),
                    Authorization: authFormattedResult.auth,
                };
            }

            if (
                pluginCacheControl !== CacheControl.NoStore &&
                !notUpdateCache
            ) {
                // 更新缓存
                const cacheSource = {
                    headers: result.headers,
                    userAgent: result.userAgent,
                    url,
                };
                let realMusicItem = {
                    ...musicItem,
                    ...(mediaCache || {}),
                };
                realMusicItem.source = {
                    ...(realMusicItem.source || {}),
                    [quality]: cacheSource,
                };

                MediaCache.setMediaCache(realMusicItem);
            }
            return result;
        } catch (e: any) {
            if (retryCount > 0 && e?.message !== "NOT RETRY") {
                await delay(150);
                return this.getMediaSource(musicItem, quality, --retryCount);
            }
            errorLog("获取真实源失败", e?.message);
            devLog("error", "获取真实源失败", e, e?.message);
            return null;
        }
    }

    /**
     * 用插件自己的产物把老曲目重建一遍（只给取源失败时用）。
     *
     * `_src` 的值是各平台私有字段（qq 要 mid + mediaMid，酷我要 rid，酷狗要 hash…），
     * 外面拼不出来，只能让插件自己给。两条路，先准后全：
     * 一、按 id 取详情——多数插件详情里就带 `_src`，跟歌名歌手对不对无关，最可靠；
     * 二、按「标题 歌手」搜一次，先认去平台前缀的 id 全等（qq_123 → 123），
     *     再退到标题 + 歌手全等；都不中就放弃，宁可失败也不拿同名不同版本凑数。
     */
    private async recoverItem(
        musicItem: IMusic.IMusicItemBase,
    ): Promise<IMusic.IMusicItemBase | null> {
        const hasSrc = (item: any) =>
            !!item?._src && Object.keys(item._src).length > 0;

        try {
            const info = await this.plugin.instance.getMusicInfo?.(musicItem);
            if (hasSrc(info)) {
                return info as IMusic.IMusicItemBase;
            }
        } catch {
            // 详情接口不可用就退到搜索
        }

        const keyword = [musicItem.title, musicItem.artist]
            .filter(Boolean)
            .join(" ");
        if (!keyword || !musicItem.id) {
            return null;
        }
        const channel = this.plugin.instance.platform ?? "";
        const bareId = (id?: string) => {
            const value = String(id ?? "");
            return channel && value.startsWith(channel + "_")
                ? value.slice(channel.length + 1)
                : value;
        };
        try {
            const result = await this.plugin.instance.search?.(
                keyword,
                1,
                "music",
            );
            const list = (result?.data ?? []) as IMusic.IMusicItemBase[];
            /**
             * 第三档只放宽"同名"的写法差异（空格/大小写/标点），但要求时长差 ≤3 秒，
             * 免得像按名取链那样把同名不同版本也认下来。
             */
            const norm = (value?: string) =>
                String(value ?? "")
                    .toLowerCase()
                    .replace(/[^0-9a-z\u4e00-\u9fa5]/g, "");
            const nearDuration = (item: any) =>
                !musicItem.duration ||
                !item.duration ||
                Math.abs(item.duration - musicItem.duration) <= 3;
            const hit =
                list.find(_ => bareId(_.id) === bareId(musicItem.id)) ??
                list.find(
                    _ =>
                        _.title === musicItem.title &&
                        _.artist === musicItem.artist,
                ) ??
                list.find(
                    _ =>
                        norm(_.title) === norm(musicItem.title) &&
                        nearDuration(_),
                );
            return hit && hasSrc(hit) ? hit : null;
        } catch {
            return null;
        }
    }

    /** 获取音乐详情 */
    async getMusicInfo(
        musicItem: ICommon.IMediaBase,
    ): Promise<Partial<IMusic.IMusicItem> | null> {
        await this.ensurePluginIsMounted();
        if (!this.plugin.instance.getMusicInfo) {
            return null;
        }
        try {
            return (
                this.plugin.instance.getMusicInfo(
                    resetMediaItem(musicItem, this.plugin.name, true),
                ) ?? null
            );
        } catch (e: any) {
            devLog("error", "获取音乐详情失败", e, e?.message);
            return null;
        }
    }

    /**
     *
     * getLyric(musicItem) => {
     *      lyric: string;
     *      trans: string;
     * }
     *
     */
    /** 获取歌词 */
    async getLyric(
        originalMusicItem: IMusic.IMusicItemBase,
    ): Promise<ILyric.ILyricSource | null> {
        await this.ensurePluginIsMounted();
        // 1.额外存储的meta信息（关联歌词）
        const associatedLrc = getMediaExtraProperty(originalMusicItem, "associatedLrc");
        let musicItem: IMusic.IMusicItem;
        if (associatedLrc) {
            musicItem = associatedLrc as IMusic.IMusicItem;
        } else {
            musicItem = originalMusicItem as IMusic.IMusicItem;
        }

        const musicItemCache = MediaCache.getMediaCache(
            musicItem,
        ) as IMusic.IMusicItemCache | null;

        /** 原始歌词文本 */
        let rawLrc: string | null = musicItem.rawLrc || null;
        let translation: string | null = null;

        // 2. 本地手动设置的歌词
        const platformHash = CryptoJs.MD5(musicItem.platform).toString(
            CryptoJs.enc.Hex,
        );
        const idHash = CryptoJs.MD5(musicItem.id).toString(CryptoJs.enc.Hex);
        if (
            await RNFS.exists(
                pathConst.localLrcPath + platformHash + "/" + idHash + ".lrc",
            )
        ) {
            rawLrc = await RNFS.readFile(
                pathConst.localLrcPath + platformHash + "/" + idHash + ".lrc",
                "utf8",
            );

            if (
                await RNFS.exists(
                    pathConst.localLrcPath +
                    platformHash +
                    "/" +
                    idHash +
                    ".tran.lrc",
                )
            ) {
                translation =
                    (await RNFS.readFile(
                        pathConst.localLrcPath +
                        platformHash +
                        "/" +
                        idHash +
                        ".tran.lrc",
                        "utf8",
                    )) || null;
            }

            return {
                rawLrc,
                translation: translation || undefined, // TODO: 这里写的不好
            };
        }

        // 2. 缓存歌词 / 对象上本身的歌词
        if (musicItemCache?.lyric) {
            // 缓存的远程结果
            let cacheLyric: ILyric.ILyricSource | null =
                musicItemCache.lyric || null;
            // 缓存的本地结果
            let localLyric: ILyric.ILyricSource | null =
                musicItemCache.$localLyric || null;

            // 优先用缓存的结果
            if (cacheLyric.rawLrc || cacheLyric.translation) {
                return {
                    rawLrc: cacheLyric.rawLrc,
                    translation: cacheLyric.translation,
                };
            }

            // 本地其实是缓存的路径
            if (localLyric) {
                let needRefetch = false;
                if (localLyric.rawLrc && (await exists(localLyric.rawLrc))) {
                    rawLrc = await readFile(localLyric.rawLrc, "utf8");
                } else if (localLyric.rawLrc) {
                    needRefetch = true;
                }
                if (
                    localLyric.translation &&
                    (await exists(localLyric.translation))
                ) {
                    translation = await readFile(
                        localLyric.translation,
                        "utf8",
                    );
                } else if (localLyric.translation) {
                    needRefetch = true;
                }

                if (!needRefetch && (rawLrc || translation)) {
                    return {
                        rawLrc: rawLrc || undefined,
                        translation: translation || undefined,
                    };
                }
            }
        }

        // 3. 无缓存歌词/无自带歌词/无本地歌词
        let lrcSource: ILyric.ILyricSource | null;
        if (isSameMediaItem(originalMusicItem, musicItem)) {
            lrcSource =
                (await this.plugin.instance
                    ?.getLyric?.(resetMediaItem(musicItem, this.plugin.name, true))
                    ?.catch(() => null)) || null;
        } else {
            lrcSource =
                (await Plugin.pluginManager?.getByMedia(musicItem)
                    ?.instance?.getLyric?.(
                        resetMediaItem(musicItem, this.plugin.name, true),
                    )
                    ?.catch(() => null)) || null;
        }

        if (lrcSource) {
            rawLrc = lrcSource?.rawLrc || rawLrc;
            translation = lrcSource?.translation || null;

            const deprecatedLrcUrl = lrcSource?.lrc || musicItem.lrc;

            // 本地的文件名
            let filename: string | undefined = `${pathConst.lrcCachePath
            }${nanoid()}.lrc`;
            let filenameTrans: string | undefined = `${pathConst.lrcCachePath
            }${nanoid()}.lrc`;

            // 旧版本兼容
            if (!(rawLrc || translation)) {
                if (deprecatedLrcUrl) {
                    rawLrc = (
                        await axios
                            .get(deprecatedLrcUrl, { timeout: 3000 })
                            .catch(() => null)
                    )?.data;
                } else if (musicItem.rawLrc) {
                    rawLrc = musicItem.rawLrc;
                }
            }

            if (rawLrc) {
                await writeFile(filename, rawLrc, "utf8");
            } else {
                filename = undefined;
            }
            if (translation) {
                await writeFile(filenameTrans, translation, "utf8");
            } else {
                filenameTrans = undefined;
            }

            if (rawLrc || translation) {
                MediaCache.setMediaCache(
                    produce(musicItemCache || musicItem, draft => {
                        musicItemCache?.$localLyric?.rawLrc;
                        objectPath.set(draft, "$localLyric.rawLrc", filename);
                        objectPath.set(
                            draft,
                            "$localLyric.translation",
                            filenameTrans,
                        );
                        return draft;
                    }),
                );
                return {
                    rawLrc: rawLrc || undefined,
                    translation: translation || undefined,
                };
            }
        }

        // 6. 如果是本地文件
        const localFilePath = getLocalPath(originalMusicItem);
        if (
            originalMusicItem.platform !== localPluginPlatform &&
            localFilePath
        ) {
            const res = await localFilePluginDefine!.getLyric!(originalMusicItem);
            devLog("info", "本地文件歌词");

            if (res) {
                return res;
            }
        }
        devLog("warn", "无歌词");

        return null;
    }


    /** 获取专辑信息 */
    async getAlbumInfo(
        albumItem: IAlbum.IAlbumItemBase,
        page: number = 1,
    ): Promise<IPlugin.IAlbumInfoResult | null> {
        await this.ensurePluginIsMounted();
        if (!this.plugin.instance.getAlbumInfo) {
            return {
                albumItem,
                /** 原来把 name 当 map 的 thisArg 传，resetMediaItem 实际收到的是下标，platform 会被写成 0 */
                musicList: (albumItem?.musicList ?? []).map(_ =>
                    resetMediaItem(_, this.plugin.name, true),
                ),
                isEnd: true,
            };
        }
        try {
            const result = await this.plugin.instance.getAlbumInfo(
                resetMediaItem(albumItem, this.plugin.name, true),
                page,
            );
            if (!result) {
                throw new Error();
            }
            result?.musicList?.forEach(_ => {
                resetMediaItem(_, this.plugin.name);
                _.album = albumItem.title;
            });

            if (page <= 1) {
                // 合并信息
                return {
                    albumItem: { ...albumItem, ...(result?.albumItem ?? {}) },
                    isEnd: result.isEnd === false ? false : true,
                    musicList: result.musicList,
                };
            } else {
                return {
                    isEnd: result.isEnd === false ? false : true,
                    musicList: result.musicList,
                };
            }
        } catch (e: any) {
            trace("获取专辑信息失败", e?.message);
            devLog("error", "获取专辑信息失败", e, e?.message);

            return null;
        }
    }

    /** 获取歌单信息 */
    async getMusicSheetInfo(
        sheetItem: IMusic.IMusicSheetItem,
        page: number = 1,
    ): Promise<IPlugin.ISheetInfoResult | null> {
        await this.ensurePluginIsMounted();
        if (!this.plugin.instance.getMusicSheetInfo) {
            return {
                sheetItem,
                musicList: sheetItem?.musicList ?? [],
                isEnd: true,
            };
        }
        try {
            const result = await this.plugin.instance?.getMusicSheetInfo?.(
                resetMediaItem(sheetItem, this.plugin.name, true),
                page,
            );
            if (!result) {
                throw new Error();
            }
            result?.musicList?.forEach(_ => {
                resetMediaItem(_, this.plugin.name);
            });

            if (page <= 1) {
                // 合并信息
                return {
                    sheetItem: { ...sheetItem, ...(result?.sheetItem ?? {}) },
                    isEnd: result.isEnd === false ? false : true,
                    musicList: result.musicList,
                };
            } else {
                return {
                    isEnd: result.isEnd === false ? false : true,
                    musicList: result.musicList,
                };
            }
        } catch (e: any) {
            trace("获取歌单信息失败", e, e?.message);
            devLog("error", "获取歌单信息失败", e, e?.message);

            return null;
        }
    }

    /** 查询作者信息 */
    async getArtistWorks<T extends IArtist.ArtistMediaType>(
        artistItem: IArtist.IArtistItem,
        page: number,
        type: T,
    ): Promise<IPlugin.ISearchResult<T>> {
        await this.ensurePluginIsMounted();
        if (!this.plugin.instance.getArtistWorks) {
            return {
                isEnd: true,
                data: [],
            };
        }
        try {
            const result = await this.plugin.instance.getArtistWorks(
                resetMediaItem(artistItem, this.plugin.name, true),
                page,
                type,
            );
            if (!result.data) {
                return {
                    isEnd: true,
                    data: [],
                };
            }
            result.data?.forEach(_ => resetMediaItem(_, this.plugin.name));
            return {
                isEnd: result.isEnd ?? true,
                data: result.data,
            };
        } catch (e: any) {
            trace("查询作者信息失败", e?.message);
            devLog("error", "查询作者信息失败", e, e?.message);

            throw e;
        }
    }

    /** 导入歌单 */
    async importMusicSheet(urlLike: string): Promise<IMusic.IMusicItem[]> {
        await this.ensurePluginIsMounted();
        try {
            const result =
                (await this.plugin.instance?.importMusicSheet?.(urlLike)) ?? [];
            result.forEach(_ => resetMediaItem(_, this.plugin.name));
            return result;
        } catch (e: any) {
            console.log(e);
            devLog("error", "导入歌单失败", e, e?.message);

            return [];
        }
    }

    /** 导入单曲 */
    async importMusicItem(urlLike: string): Promise<IMusic.IMusicItem | null> {
        await this.ensurePluginIsMounted();
        try {
            const result = await this.plugin.instance?.importMusicItem?.(
                urlLike,
            );
            if (!result) {
                throw new Error();
            }
            resetMediaItem(result, this.plugin.name);
            return result;
        } catch (e: any) {
            devLog("error", "导入单曲失败", e, e?.message);

            return null;
        }
    }

    /** 获取榜单 */
    async getTopLists(): Promise<IMusic.IMusicSheetGroupItem[]> {
        await this.ensurePluginIsMounted();
        try {
            const result = await this.plugin.instance?.getTopLists?.();
            if (!result) {
                throw new Error();
            }
            return result;
        } catch (e: any) {
            devLog("error", "获取榜单失败", e, e?.message);
            return [];
        }
    }

    /** 获取榜单详情 */
    async getTopListDetail(
        topListItem: IMusic.IMusicSheetItemBase,
        page: number,
    ): Promise<IPlugin.ITopListInfoResult> {
        await this.ensurePluginIsMounted();
        const result = await this.plugin.instance?.getTopListDetail?.(
            topListItem,
            page,
        );
        if (!result) {
            throw new Error();
        }
        if (result.musicList) {
            result.musicList.forEach(_ =>
                resetMediaItem(_, this.plugin.name),
            );
        } else {
            result.musicList = [];
        }
        if (result.isEnd !== false) {
            result.isEnd = true;
        }
        return result;
    }

    /** 获取推荐歌单的tag */
    async getRecommendSheetTags(): Promise<IPlugin.IGetRecommendSheetTagsResult> {
        await this.ensurePluginIsMounted();
        try {
            const result =
                await this.plugin.instance?.getRecommendSheetTags?.();
            if (!result) {
                throw new Error();
            }
            return result;
        } catch (e: any) {
            devLog("error", "获取推荐歌单失败", e, e?.message);
            return {
                data: [],
            };
        }
    }

    /** 获取某个tag的推荐歌单 */
    async getRecommendSheetsByTag(
        tagItem: ICommon.IUnique,
        page?: number,
    ): Promise<ICommon.PaginationResponse<IMusic.IMusicSheetItemBase>> {
        await this.ensurePluginIsMounted();
        try {
            const result =
                await this.plugin.instance?.getRecommendSheetsByTag?.(
                    tagItem,
                    page ?? 1,
                );
            if (!result) {
                throw new Error();
            }
            if (result.isEnd !== false) {
                result.isEnd = true;
            }
            if (!result.data) {
                result.data = [];
            }
            result.data.forEach(item => resetMediaItem(item, this.plugin.name));

            return result;
        } catch (e: any) {
            devLog("error", "获取推荐歌单详情失败", e, e?.message);
            return {
                isEnd: true,
                data: [],
            };
        }
    }

    async getMusicComments(
        musicItem: IMusic.IMusicItem,
        page?: number
    ): Promise<ICommon.PaginationResponse<IMedia.IComment>> {
        await this.ensurePluginIsMounted();
        const result = await this.plugin.instance?.getMusicComments?.(
            musicItem,
            page ?? 1
        );
        if (!result) {
            throw new Error();
        }
        if (result.isEnd !== false) {
            result.isEnd = true;
        }
        if (!result.data) {
            result.data = [];
        }

        return result;
    }
}

//#region 插件类
export class Plugin {
    /** 插件名 */
    public name: string = "";
    /**
     * 展示名：用户起的别名优先，未设置则为插件原名。
     * 只用于界面展示，既不写进曲目数据、也不参与平台解析（解析只认主键和 matchNames）。
     * meta 存储的键（收藏、MediaExtra、播放缓存、用户变量、排序、禁用）一律仍挂 name。
     * 传给插件函数的入参一律盖回 name——插件内部常按自己的 platform 分支。
     */
    get displayName(): string {
        return _internalPluginMeta.getPluginAlias(this.name) || this.name;
    }
    /**
     * 匹配名：历史曲目里出现的这些平台写法都算作本插件。
     * 换插件（主键变了）之后，靠它把存量歌单认领回来。
     */
    get matchNames(): string[] {
        return _internalPluginMeta.getPluginMatchNames(this.name);
    }
    /**
     * 插件自己声明的展示名（插件导出里的 `name`，如「QQ音乐」）。
     * 本端曲目存 platform 主键（qq），别的客户端/旧备份存的是这个名字。
     */
    get declaredName(): string {
        return this.instance?.name ?? "";
    }
    /** 插件的hash，作为唯一id */
    public hash: string = "";
    /** 插件状态：激活、关闭、错误 */
    public state: PluginState = PluginState.Initializing;
    /** 插件出错时的原因 */
    public errorReason?: PluginErrorReason;
    /** 插件的实例 */
    public instance: IPlugin.IPluginDefine = { platform: "" };
    /** 插件路径 */
    public path: string = "";
    /** 插件方法，内部进行标准化和校验 */
    public methods!: IPlugin.IPluginInstanceMethods;

    public supportedMethods: Set<keyof IPlugin.IPluginInstanceMethods> = new Set();

    private lazyProps: ILazyProps | null = null;

    static pluginManager: IPluginManager;

    static injectDependencies(
        pluginManager: IPluginManager,
    ) {
        Plugin.pluginManager = pluginManager;
    }

    constructor(
        funcCode: string | (() => IPlugin.IPluginDefine) | null,
        pluginPath: string,
        lazyProps: ILazyProps | null = null
    ) {
        this.lazyProps = lazyProps;
        if (!lazyProps) {
            // 如果没有懒加载，直接挂载并初始化
            this.mountPlugin(funcCode!, pluginPath);
            this.methods = new PluginMethodsWrapper(this, async () => {});
        } else {
            // 使用懒加载参数初始化
            this.name = lazyProps.name;
            this.hash = lazyProps.hash;
            this.path = lazyProps.path;
            this.instance = lazyProps.instance ?? {
                platform: lazyProps.name,
            };
            this.supportedMethods = new Set((lazyProps.supportedMethods ?? []) as any);
            // 初始化方法，但实际调用时会先挂载插件
            this.methods = new PluginMethodsWrapper(this, this.ensureMounted.bind(this));
        }
    }

    async ensureMounted() {
        if ((this.state === PluginState.Initializing) && this.lazyProps) {
            this.state = PluginState.Loading;
            // 懒加载
            const loadFuncCode = this.lazyProps.loadFuncCode ?? (() => "");
            try {
                const funcCode = await loadFuncCode();
                this.mountPlugin(funcCode, this.lazyProps.path);
            } catch {
                this.state = PluginState.Error;
                this.errorReason = this.errorReason ?? PluginErrorReason.CannotParse;
            }
        }
    }

    private mountPlugin(
        funcCode: string | (() => IPlugin.IPluginDefine),
        pluginPath: string) {
        this.state = PluginState.Loading;
        let _instance: IPlugin.IPluginDefine;

        const _module: any = { exports: {} };
        try {
            if (typeof funcCode === "string") {
                // 插件的环境变量
                const env = {
                    getUserVariables: () => {
                        return (
                            _internalPluginMeta.getUserVariables(this.name)
                        );
                    },
                    get userVariables() {
                        return this.getUserVariables() ?? {};
                    },
                    appVersion,
                    os: "android",
                    lang: "zh-CN",
                };
                const _process = {
                    platform: "android",
                    version: appVersion,
                    env,
                };

                // eslint-disable-next-line no-new-func
                _instance = Function(`
                    'use strict';
                    return function(require, __musicfree_require, module, exports, console, env, URL, process) {
                        ${funcCode}
                    }
                `)()(
                    _require,
                    _require,
                    _module,
                    _module.exports,
                    _console,
                    env,
                    URL,
                    _process
                );
                if (_module.exports.default) {
                    _instance = _module.exports
                        .default as IPlugin.IPluginInstance;
                } else {
                    _instance = _module.exports as IPlugin.IPluginInstance;
                }
            } else {
                _instance = funcCode();
            }
            // 插件初始化后的一些操作
            if (Array.isArray(_instance.userVariables)) {
                _instance.userVariables = _instance.userVariables.filter(
                    it => it?.key,
                );
            }
            this.checkValid(_instance);
        } catch (e: any) {
            this.state = PluginState.Error;
            this.errorReason = e?.errorReason ?? PluginErrorReason.CannotParse;

            errorLog(`${pluginPath}插件无法解析 `, {
                errorReason: this.errorReason,
                message: e?.message,
                stack: e?.stack,
            });
            _instance = e?.instance ?? {
                platform: "",
                appVersion: "",
                async getMediaSource() {
                    return null;
                },
                async search() {
                    return {};
                },
                async getAlbumInfo() {
                    return null;
                },
            };
        }

        this.instance = _instance;
        this.path = pluginPath;
        this.name = _instance.platform;
        this.supportedMethods = new Set(Object.keys(_instance).filter(
            key => typeof (_instance[key]) === "function",
        ) as any);

        // 检测name & 计算hash
        if (
            this.name === "" ||
            !this.name
        ) {
            this.hash = "";
            this.state = PluginState.Error;
            this.errorReason = this.errorReason ?? PluginErrorReason.CannotParse;
        } else {
            if (typeof funcCode === "string") {
                this.hash = sha256(funcCode).toString();
            } else {
                this.hash = sha256(pluginPath + "@" + appVersion).toString();
            }
        }


        if (this.state !== PluginState.Error) {
            this.state = PluginState.Mounted;
        }
    }

    private checkValid(_instance: IPlugin.IPluginDefine) {
        /** 版本号校验 */
        if (
            _instance.appVersion &&
            !satisfies(DeviceInfo.getVersion(), _instance.appVersion)
        ) {
            throw {
                instance: _instance,
                state: PluginState.Error,
                errorReason: PluginErrorReason.VersionNotMatch,
            };
        }
        return true;
    }
}


const localFilePluginDefine: IPlugin.IPluginDefine = {
    platform: localPluginPlatform,
    async getMusicInfo(musicBase) {
        const localPath = getLocalPath(musicBase);
        if (localPath) {
            const coverImg = await Mp3Util.getMediaCoverImg(localPath);
            return {
                artwork: coverImg,
            };
        }
        return null;
    },
    async getLyric(musicBase) {
        const localPath = getLocalPath(musicBase);
        let rawLrc: string | null = null;
        if (localPath) {
            // 读取内嵌歌词
            try {
                rawLrc = await Mp3Util.getLyric(localPath);
            } catch (e) {
                console.log("读取内嵌歌词失败", e);
            }
            if (!rawLrc) {
                // 读取配置歌词
                const lastDot = localPath.lastIndexOf(".");
                const lrcPath = localPath.slice(0, lastDot) + ".lrc";

                try {
                    if (await exists(lrcPath)) {
                        rawLrc = await readFile(lrcPath, "utf8");
                    }
                } catch { }
            }
        }

        return rawLrc
            ? {
                rawLrc,
            }
            : null;
    },
    async importMusicItem(urlLike) { // 绝对路径
        let meta: any = {};
        let id: string;

        try {
            meta = await Mp3Util.getBasicMeta(urlLike);
            const fileStat = await stat(urlLike);
            id =
                CryptoJs.MD5(fileStat.originalFilepath).toString(
                    CryptoJs.enc.Hex,
                ) || nanoid();
        } catch {
            id = nanoid();
        }

        return {
            id: id,
            platform: localPluginPlatform,
            title: meta?.title ?? getFileName(urlLike),
            artist: meta?.artist ?? "未知歌手",
            duration: parseInt(meta?.duration ?? "0", 10) / 1000,
            album: meta?.album ?? "未知专辑",
            artwork: "",
            [internalSerializeKey]: {
                localPath: urlLike,
            },
            url: urlLike,
        };
    },
    async getMediaSource(musicItem, quality) {
        if (quality === "standard") {
            return {
                url: addFileScheme(musicItem.$?.localPath || musicItem.url),
            };
        }
        return null;
    },

};

export const localFilePlugin = new Plugin(function () {
    return localFilePluginDefine;
}, "internal-plugin://local-file-plugin");

