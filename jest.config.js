module.exports = {
    preset: 'react-native',
    /**
     * react-native-url-polyfill 发布的是未转译的 ESM，
     * 默认会被 node_modules 排除规则跳过而导致 SyntaxError，这里连同 RN 生态一并交给 babel。
     */
    transformIgnorePatterns: [
        'node_modules/(?!((jest-)?react-native|@react-native(-community)?|react-native-url-polyfill)/)',
    ],
};
