import React, { useState } from "react";
import { FlatList, StyleSheet, View } from "react-native";
import rpx from "@/utils/rpx";
import * as DocumentPicker from "expo-document-picker";
import Loading from "@/components/base/loading";

import PluginManager, { useSortedPlugins } from "@/core/pluginManager";
import { devLog, trace } from "@/utils/log";

import Toast from "@/utils/toast";
import { fetchPluginText } from "@/core/pluginManager/fetchText";
import {
    parseSubscribeEntries,
    planSubscribeEntries,
    type ISubscribeEntry,
} from "@/core/pluginManager/subscription";
import { useNavigation } from "@react-navigation/native";
import Config from "@/core/appConfig";
import Empty from "@/components/base/empty";
import HorizontalSafeAreaView from "@/components/base/horizontalSafeAreaView.tsx";
import { showDialog } from "@/components/dialogs/useDialog";
import { showPanel } from "@/components/panels/usePanel";
import AppBar from "@/components/base/appBar";
import Fab from "@/components/base/fab";
import PluginItem from "../components/pluginItem";
import { IIconName } from "@/components/base/icon.tsx";
import { IInstallPluginResult } from "@/types/core/pluginManager";
import i18n, { useI18N } from "@/core/i18n";
import { safeParse } from "@/utils/jsonUtil";

interface IOption {
    icon: IIconName;
    title: string;
    onPress?: () => void;
}

export default function PluginList() {
    const plugins = useSortedPlugins();
    const { t } = useI18N();

    const [loading, setLoading] = useState(false);

    const navigator = useNavigation<any>();

    const menuOptions: IOption[] = [
        {
            icon: "bookmark-square",
            title: t("pluginSetting.menu.subscriptionSetting"),
            async onPress() {
                navigator.navigate("/pluginsetting/subscribe");
            },
        },
        {
            icon: "bars-3",
            title: t("pluginSetting.menu.sort"),
            onPress() {
                navigator.navigate("/pluginsetting/sort");
            },
        },
        {
            icon: "trash-outline",
            title: t("pluginSetting.menu.uninstallAll"),
            onPress() {
                showDialog("SimpleDialog", {
                    title: t("pluginSetting.menu.uninstallAll"),
                    content: t("pluginSetting.menu.uninstallAllContent"),
                    async onOk() {
                        setLoading(true);
                        await PluginManager.uninstallAllPlugins();
                        setLoading(false);
                    },
                });
            },
        },
    ];

    async function onInstallFromLocalClick() {
        try {
            const results = await DocumentPicker.getDocumentAsync({
                copyToCacheDirectory: true,
                multiple: true,
                type: ["application/javascript", "text/javascript"],
            });
            if (results.canceled) {
                // 用户取消
                return;
            }
            setLoading(true);

            await Promise.all(
                results.assets.map(async it => {
                    await PluginManager.installPluginFromLocalFile(it.uri, {
                        notCheckVersion: Config.getConfig(
                            "basic.notCheckPluginVersion",
                        ),
                        useExpoFs: true,
                    });
                }),
            );
            // 初步过滤

            Toast.success(t("toast.installPluginSuccess"));
        } catch (e: any) {
            trace("插件安装失败", e?.message);
            Toast.warn(t("toast.installPluginFail", {
                reason: e?.message ?? "",
            }));
        }
        setLoading(false);
    }

    async function onInstallFromNetworkClick() {
        showPanel("SimpleInput", {
            title: t("pluginSetting.menu.installPlugin"),
            placeholder: t("pluginSetting.menu.installPluginDialogPlaceholder"),
            maxLength: 200,
            async onOk(text, closePanel) {
                setLoading(true);
                closePanel();

                const results = await installFromInput(text.trim());
                reportInstallResults(results, {
                    success: t("toast.installPluginSuccess"),
                    partialFailed: t("toast.partialPluginInstallFailed"),
                    allFailed: t("toast.allPluginInstallFailed"),
                    dialogTitle: t("pluginSetting.menu.pluginInstallFailedDialogTitle"),
                    dialogContent: detail =>
                        t("pluginSetting.pluginInstallFailedDialogContent", {
                            detail,
                        }),
                });
                setLoading(false);
            },
        });
    }

    async function onSubscribeClick() {
        const urls = Config.getConfig("plugin.subscribeUrl");
        const inputs = parseSubscribeInputs(urls);
        if (!inputs.length) {
            Toast.warn(
                urls?.trim()
                    ? t("toast.subscriptionInvalid")
                    : t("toast.noSubscription"),
            );
            return;
        }
        setLoading(true);

        const results: IInstallPluginResult[] = [];
        for (let i = 0; i < inputs.length; ++i) {
            results.push(...(await installFromInput(inputs[i])));
        }

        reportInstallResults(results, {
            success: t("toast.installPluginSuccess"),
            partialFailed: t("toast.partialPluginInstallFailed"),
            allFailed: t("toast.allPluginInstallFailed"),
            dialogTitle: t("pluginSetting.menu.pluginInstallFailedDialogTitle"),
            dialogContent: detail =>
                t("pluginSetting.pluginInstallFailedDialogContent", {
                    detail,
                }),
        });
        setLoading(false);
    }

    async function onUpdateAllClick() {
        const plugins = PluginManager.getEnabledPlugins();
        setLoading(true);

        const results: IInstallPluginResult[] = [];
        for (let i = 0; i < plugins.length; ++i) {
            const srcUrl = plugins[i].instance.srcUrl;
            if (srcUrl) {
                results.push(...(await installFromInput(srcUrl)));
            }
        }

        reportInstallResults(results, {
            success: t("toast.updatePluginSuccess"),
            partialFailed: t("toast.partialPluginUpdateFailed"),
            allFailed: t("toast.allPluginUpdateFailed"),
            dialogTitle: t("pluginSetting.menu.pluginUpdateFailedDialogTitle"),
            dialogContent: detail =>
                t("pluginSetting.pluginUpdateFailedDialogContent", {
                    detail,
                }),
        });
        setLoading(false);
    }

    return (
        <>
            <AppBar menu={menuOptions}>{t("sidebar.pluginManagement")}</AppBar>
            <HorizontalSafeAreaView style={style.wrapper}>
                <>
                    {loading ? (
                        <Loading />
                    ) : (
                        <FlatList
                            ListEmptyComponent={Empty}
                            ListFooterComponent={<View style={style.blank} />}
                            data={plugins ?? []}
                            keyExtractor={_ => _.hash}
                            renderItem={({ item: plugin }) => (
                                <PluginItem key={plugin.hash} plugin={plugin} />
                            )}
                        />
                    )}

                    <Fab
                        icon="plus"
                        onPress={() => {
                            showPanel("SimpleSelect", {
                                header: t("pluginSetting.menu.installPlugin"),
                                candidates: [
                                    {
                                        value: "从本地安装插件",
                                        title: t("pluginSetting.fabOptions.installFromLocal"),
                                    },
                                    {
                                        value: "从网络安装插件",
                                        title: t("pluginSetting.fabOptions.installFromNetwork"),
                                    },
                                    {
                                        value: "更新全部插件",
                                        title: t("pluginSetting.fabOptions.updateAllPlugins"),
                                    },
                                    {
                                        value: "更新订阅",
                                        title: t("pluginSetting.fabOptions.updateSubscription"),
                                    },
                                ],
                                onPress(item) {
                                    if (item.value === "从本地安装插件") {
                                        onInstallFromLocalClick();
                                    } else if (
                                        item.value === "从网络安装插件"
                                    ) {
                                        onInstallFromNetworkClick();
                                    } else if (item.value === "更新订阅") {
                                        onSubscribeClick();
                                    } else if (item.value === "更新全部插件") {
                                        onUpdateAllClick();
                                    }
                                },
                            });
                        }}
                    />
                </>
            </HorizontalSafeAreaView>
        </>
    );
}

const style = StyleSheet.create({
    wrapper: {
        width: "100%",
        flex: 1,
    },
    blank: {
        height: rpx(200),
    },
});



/** 订阅地址存的是 [{name,url}] 的 JSON；解析不出数组时整串按单个地址处理（旧数据） */
function parseSubscribeInputs(raw?: string): string[] {
    const text = raw?.trim() ?? "";
    if (!text) {
        return [];
    }
    const parsed = safeParse<Array<{ url?: string }>>(text);
    if (!Array.isArray(parsed)) {
        return [text];
    }
    return parsed.map(it => it?.url?.trim() ?? "").filter(Boolean);
}

/**
 * 安装一个订阅地址或单个插件地址。
 * .json 视为订阅：先解析条目，本地已同版本的直接跳过，避免几百 KB 的重复下载。
 * 返回逐条结果，跳过项不产生结果（既不算成功也不算失败）。
 */
async function installFromInput(text: string): Promise<IInstallPluginResult[]> {
    const inputUrl = text.trim();
    const notCheckVersion = !!Config.getConfig("basic.notCheckPluginVersion");
    if (!inputUrl.endsWith(".json")) {
        return [
            await PluginManager.installPluginFromUrl(inputUrl, {
                notCheckVersion,
            }),
        ];
    }

    let entries: ISubscribeEntry[];
    try {
        entries = parseSubscribeEntries(await fetchPluginText(inputUrl), inputUrl);
    } catch (e: any) {
        return [{ success: false, message: e?.message ?? "", pluginUrl: inputUrl }];
    }
    if (!entries.length) {
        return [
            {
                success: false,
                message: i18n.t("toast.subscriptionContentInvalid"),
                pluginUrl: inputUrl,
            },
        ];
    }

    const actions = planSubscribeEntries(
        entries,
        PluginManager.getSortedPlugins().map(plugin => ({
            name: plugin.name,
            version: plugin.instance.version,
        })),
    );

    const results: IInstallPluginResult[] = [];
    /** 串行而非并发：几个几百 KB 的插件同时下会互相抢带宽，一起撞上超时 */
    for (const action of actions) {
        if (action.action === "skip") {
            devLog("info", "订阅跳过同版本插件:", action.name);
            continue;
        }
        results.push(
            await PluginManager.installPluginFromUrl(action.url, {
                notCheckVersion,
            }),
        );
    }
    return results;
}

interface IInstallReportTexts {
    success: string;
    partialFailed: string;
    allFailed: string;
    dialogTitle: string;
    dialogContent: (detail: string) => string;
}

/** 有任何一条失败就不能报整体成功；失败明细原样带上 URL 与原因（超时/404/无法解析） */
function reportInstallResults(
    results: IInstallPluginResult[],
    texts: IInstallReportTexts,
) {
    const failResults = results.filter(it => !it.success);
    if (!failResults.length) {
        Toast.success(texts.success);
        return;
    }
    Toast.warn(
        failResults.length === results.length
            ? texts.allFailed
            : texts.partialFailed,
        {
            type: "warn",
            actionText: i18n.t("common.view"),
            onActionClick: () => {
                showDialog("SimpleDialog", {
                    title: texts.dialogTitle,
                    content: texts.dialogContent(
                        failResults
                            .map(
                                it =>
                                    (it.pluginUrl ?? "") +
                                    "\n" +
                                    i18n.t("pluginSetting.failReason", {
                                        reason: it.message ?? "",
                                    }),
                            )
                            .join("\n-----\n"),
                    ),
                });
            },
        },
    );
}
