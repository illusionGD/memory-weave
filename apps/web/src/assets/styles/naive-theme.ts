import type { GlobalThemeOverrides } from 'naive-ui';

/** 星空聊天端的组件主题，与页面蓝紫色调和扁平控件保持一致。 */
export const naiveTheme: GlobalThemeOverrides = {
  common: {
    primaryColor: '#c5b9ef',
    primaryColorHover: '#d4c9f6',
    primaryColorPressed: '#b2a1e2',
    primaryColorSuppl: '#b2a1e2',
    bodyColor: '#11182b',
    cardColor: '#1c243a',
    modalColor: '#1c243a',
    popoverColor: '#252e46',
    textColor1: '#eeedf5',
    textColor2: '#eeedf5',
    textColor3: '#a6abc3',
    borderColor: '#30394f',
    dividerColor: '#30394f',
    errorColor: '#f3b1b6',
    fontFamily: "'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif",
    borderRadius: '10px',
    heightMedium: '42px',
    heightLarge: '46px',
  },
  Button: {
    textColorPrimary: '#25213c',
    textColorHoverPrimary: '#25213c',
    textColorPressedPrimary: '#25213c',
    textColorFocusPrimary: '#25213c',
    fontWeight: '500',
  },
  Input: { color: '#1c243a', colorFocus: '#1c243a' },
};
