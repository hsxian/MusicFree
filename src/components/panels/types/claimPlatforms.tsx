import React, { useState } from "react";
import { StyleSheet } from "react-native";
import { ScrollView } from "react-native-gesture-handler";
import rpx, { vmax } from "@/utils/rpx";
import PanelBase from "../base/panelBase";
import PanelHeader from "../base/panelHeader";
import { hidePanel } from "../usePanel";
import { showDialog } from "@/components/dialogs/useDialog";
import ListItem from "@/components/base/listItem";
import ThemeText from "@/components/base/themeText";
import Toast from "@/utils/toast";
import { useI18N } from "@/core/i18n";
import pluginManager from "@/core/pluginManager";
import MusicSheet from "@/core/musicSheet";
import musicHistory from "@/core/musicHistory";

/**
 * 修复失效平台名。
 *
 * 换插件后存量歌单里的 platform 往往谁都认不出来，表现为整张歌单点不动。
 * 这里把认不出的名子挑出来，让用户认领给某个插件——认领只是给插件加一条匹配名，
 * 不动歌单数据，删掉匹配名就能回滚。
 */
export default function ClaimPlatforms() {
    const { t } = useI18N();
    const [unknowns, setUnknowns] = useState(collectUnknownPlatforms);

    const claim = (platform: string, pluginName: string) => {
        const plugin = pluginManager.getByName(pluginName);
        if (!plugin) {
            return;
        }
        const names = pluginManager.getPluginMatchNames(plugin);
        const conflict = pluginManager.setPluginMatchNames(plugin, [
            ...names,
            platform,
        ]);
        if (conflict) {
            Toast.warn(
                t(
                    conflict === "platform"
                        ? "pluginSetting.pluginItem.dialog.aliasConflictPlatform"
                        : "pluginSetting.pluginItem.dialog.aliasConflictAlias",
                ),
            );
            return;
        }
        Toast.success(
            t("pluginSetting.claimPlatforms.success", { platform }),
        );
        setUnknowns(prev => prev.filter(it => it.platform !== platform));
    };

    const pickPlugin = (platform: string) => {
        showDialog("RadioDialog", {
            title: t("pluginSetting.claimPlatforms.pickPlugin", { platform }),
            content: pluginManager
                .getSortedPlugins()
                .map(it => ({ label: it.displayName, value: it.name })),
            onOk(value) {
                claim(platform, String(value));
            },
        });
    };

    return (
        <PanelBase
            height={vmax(80)}
            positionMethod="top"
            keyboardAvoidBehavior="none"
            renderBody={() => (
                <>
                    <PanelHeader
                        title={t("pluginSetting.claimPlatforms.title")}
                        hideButtons
                        onCancel={hidePanel}
                    />
                    <ScrollView contentContainerStyle={styles.body}>
                        {unknowns.length === 0 ? (
                            <ThemeText
                                fontColor="textSecondary"
                                style={styles.empty}>
                                {t("pluginSetting.claimPlatforms.empty")}
                            </ThemeText>
                        ) : (
                            <ThemeText
                                fontColor="textSecondary"
                                style={styles.hint}>
                                {t("pluginSetting.claimPlatforms.hint")}
                            </ThemeText>
                        )}
                        {unknowns.map(it => (
                            <ListItem
                                key={it.platform}
                                withHorizontalPadding
                                onPress={() => pickPlugin(it.platform)}>
                                <ListItem.Content
                                    title={it.platform}
                                    description={t(
                                        "pluginSetting.claimPlatforms.count",
                                        { count: it.count },
                                    )}
                                />
                            </ListItem>
                        ))}
                    </ScrollView>
                </>
            )}
        />
    );
}

/** 扫歌单与播放历史，按出现次数降序排；解析得到插件的名子不算失效 */
function collectUnknownPlatforms() {
    const counter = new Map<string, number>();
    const add = (platform?: string) => {
        if (!platform || pluginManager.getByName(platform)) {
            return;
        }
        counter.set(platform, (counter.get(platform) ?? 0) + 1);
    };

    MusicSheet.backupSheets().forEach(sheet =>
        sheet.musicList?.forEach(musicItem => add(musicItem.platform)),
    );
    musicHistory.history.forEach(musicItem => add(musicItem.platform));

    return [...counter]
        .map(([platform, count]) => ({ platform, count }))
        .sort((a, b) => b.count - a.count);
}

const styles = StyleSheet.create({
    body: {
        paddingBottom: vmax(10),
    },
    empty: {
        paddingHorizontal: rpx(24),
        paddingVertical: rpx(32),
    },
    hint: {
        paddingHorizontal: rpx(24),
        paddingTop: rpx(16),
        paddingBottom: rpx(8),
    },
});
