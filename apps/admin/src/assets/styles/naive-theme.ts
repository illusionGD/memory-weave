import type { GlobalThemeOverrides } from 'naive-ui';

/** 后台管理端的组件主题，保持蓝灰色界面和紧凑的管理控件。 */
export const naiveTheme: GlobalThemeOverrides = {
  common: {
    primaryColor: '#3c66b1',
    primaryColorHover: '#2c5193',
    primaryColorPressed: '#24447b',
    primaryColorSuppl: '#3c66b1',
    bodyColor: '#f3f5f9',
    cardColor: '#ffffff',
    modalColor: '#ffffff',
    popoverColor: '#ffffff',
    textColor1: '#25324a',
    textColor2: '#25324a',
    textColor3: '#758299',
    borderColor: '#e2e7ef',
    dividerColor: '#e2e7ef',
    errorColor: '#b34c49',
    fontFamily: "'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif",
    borderRadius: '6px',
    heightMedium: '36px',
    heightLarge: '42px',
  },
  Button: { fontWeight: '500' },
};
