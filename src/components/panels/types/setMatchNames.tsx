import React, { useState } from "react";
import { KeyboardAvoidingView, StyleSheet, View } from "react-native";
import { ScrollView } from "react-native-gesture-handler";
import rpx, { vmax } from "@/utils/rpx";
import useColors from "@/hooks/useColors";
import ThemeText from "@/components/base/themeText";
import PanelBase from "../base/panelBase";
import { hidePanel } from "../usePanel";
import ListItem from "@/components/base/listItem";
import Input from "@/components/base/input";
import IconButton from "@/components/base/iconButton";
import globalStyle from "@/constants/globalStyle";
import PanelHeader from "../base/panelHeader";
import { useI18N } from "@/core/i18n";

interface ISetMatchNamesProps {
    title?: string;
    initNames?: string[];
    onOk: (names: string[], closePanel: () => void) => void;
    onCancel?: () => void;
}

export default function SetMatchNames(props: ISetMatchNamesProps) {
    const { onOk, onCancel, initNames = [], title } = props;
    const colors = useColors();
    const { t } = useI18N();

    const [names, setNames] = useState<string[]>(initNames);
    const [draft, setDraft] = useState("");

    const addDraft = () => {
        const name = draft.trim();
        setDraft("");
        if (!name || names.includes(name)) {
            return;
        }
        setNames([...names, name]);
    };

    return (
        <PanelBase
            height={vmax(80)}
            positionMethod="top"
            keyboardAvoidBehavior="none"
            renderBody={() => (
                <>
                    <PanelHeader
                        title={title ?? t("pluginSetting.pluginItem.dialog.matchNamesTitle")}
                        onCancel={() => {
                            onCancel?.();
                            hidePanel();
                        }}
                        onOk={async () => {
                            onOk(names, hidePanel);
                        }}
                    />
                    <KeyboardAvoidingView
                        behavior="padding"
                        style={globalStyle.flex1}>
                        <ScrollView
                            contentContainerStyle={{
                                paddingBottom: vmax(10),
                            }}>
                            {names.length === 0 ? (
                                <ThemeText
                                    fontColor="textSecondary"
                                    style={styles.empty}>
                                    {t("pluginSetting.pluginItem.dialog.matchNamesEmpty")}
                                </ThemeText>
                            ) : null}
                            {names.map(name => (
                                <ListItem
                                    key={name}
                                    withHorizontalPadding
                                    style={styles.listItem}>
                                    <ThemeText
                                        numberOfLines={1}
                                        ellipsizeMode="tail"
                                        style={styles.name}>
                                        {name}
                                    </ThemeText>
                                    <IconButton
                                        name="trash-outline"
                                        sizeType="light"
                                        onPress={() => {
                                            setNames(names.filter(it => it !== name));
                                        }}
                                    />
                                </ListItem>
                            ))}
                        </ScrollView>
                        <View style={styles.addBar}>
                            <Input
                                value={draft}
                                onChangeText={setDraft}
                                onSubmitEditing={addDraft}
                                returnKeyType="done"
                                placeholder={t(
                                    "pluginSetting.pluginItem.dialog.matchNamesPlaceholder",
                                )}
                                style={[
                                    styles.input,
                                    { backgroundColor: colors.placeholder },
                                ]}
                            />
                            <IconButton
                                name="plus"
                                sizeType="light"
                                onPress={addDraft}
                            />
                        </View>
                    </KeyboardAvoidingView>
                </>
            )}
        />
    );
}

const styles = StyleSheet.create({
    listItem: {
        justifyContent: "space-between",
    },
    name: {
        flexShrink: 1,
    },
    empty: {
        paddingHorizontal: rpx(24),
        paddingVertical: rpx(32),
    },
    addBar: {
        flexDirection: "row",
        alignItems: "center",
        paddingHorizontal: rpx(24),
        paddingVertical: rpx(16),
        gap: rpx(12),
    },
    input: {
        flex: 1,
        paddingVertical: rpx(12),
        paddingHorizontal: rpx(16),
        borderRadius: rpx(8),
    },
});
