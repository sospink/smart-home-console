import type { GlobalThemeOverrides } from "naive-ui";

export const zhijingThemeOverrides: GlobalThemeOverrides = {
  common: {
    primaryColor: "#32aaff",
    primaryColorHover: "#5dbbff",
    primaryColorPressed: "#1894e9",
    primaryColorSuppl: "#32aaff",
    successColor: "#18c891",
    warningColor: "#f4a340",
    errorColor: "#ff5d72",
    infoColor: "#32aaff",
    bodyColor: "#f5f6f7",
    cardColor: "#ffffff",
    modalColor: "#ffffff",
    popoverColor: "#ffffff",
    tableColor: "transparent",
    inputColor: "#f6f7f8",
    actionColor: "#f3f4f5",
    textColorBase: "#191b1e",
    textColor1: "#191b1e",
    textColor2: "#555a60",
    textColor3: "#92969c",
    borderColor: "rgba(25, 28, 32, .06)",
    dividerColor: "rgba(25, 28, 32, .04)",
    borderRadius: "12px",
    borderRadiusSmall: "10px",
    fontFamily: '"Noto Sans SC", "Source Han Sans SC", "Microsoft YaHei", system-ui, sans-serif',
    fontSize: "13px",
    heightMedium: "38px",
    heightLarge: "44px",
    boxShadow1: "0 8px 26px rgba(40, 47, 58, .08)",
    boxShadow2: "0 18px 52px rgba(40, 47, 58, .12)",
    boxShadow3: "0 26px 72px rgba(40, 47, 58, .16)"
  },
  Button: {
    fontWeight: "600",
    borderRadiusMedium: "12px",
    borderRadiusLarge: "14px"
  },
  Input: {
    borderHover: "1px solid rgba(50, 170, 255, .45)",
    borderFocus: "1px solid #32aaff",
    boxShadowFocus: "0 0 0 2px rgba(50, 170, 255, .1)"
  },
  Select: { peers: { InternalSelection: { borderRadius: "12px" } } },
  DataTable: {
    thColor: "#f6f7f8",
    tdColor: "transparent",
    tdColorHover: "rgba(50, 170, 255, .04)",
    borderColor: "transparent",
    thTextColor: "#8c9096",
    tdTextColor: "#3b3f44"
  },
  Tabs: {
    tabTextColorLine: "#8c9096",
    tabTextColorActiveLine: "#191b1e",
    barColor: "#32aaff"
  },
  Modal: { color: "#ffffff", borderRadius: "18px" },
  Drawer: { color: "#ffffff" },
  Notification: { color: "#ffffff" }
};

export const zhijingDarkThemeOverrides: GlobalThemeOverrides = {
  common: {
    primaryColor: "#32aaff",
    primaryColorHover: "#5dbbff",
    primaryColorPressed: "#1894e9",
    primaryColorSuppl: "#32aaff",
    successColor: "#31d39b",
    warningColor: "#f4aa51",
    errorColor: "#ff667a",
    infoColor: "#32aaff",
    bodyColor: "#101113",
    cardColor: "#1c1d20",
    modalColor: "#1c1d20",
    popoverColor: "#24262a",
    tableColor: "transparent",
    inputColor: "#24262a",
    actionColor: "#24262a",
    textColorBase: "#f3f4f5",
    textColor1: "#f3f4f5",
    textColor2: "#c4c7cb",
    textColor3: "#a4a7ac",
    borderColor: "rgba(255, 255, 255, .07)",
    dividerColor: "rgba(255, 255, 255, .05)",
    borderRadius: "12px",
    borderRadiusSmall: "10px",
    fontFamily: '"Noto Sans SC", "Source Han Sans SC", "Microsoft YaHei", system-ui, sans-serif',
    fontSize: "13px",
    heightMedium: "38px",
    heightLarge: "44px",
    boxShadow1: "0 8px 26px rgba(0, 0, 0, .24)",
    boxShadow2: "0 18px 52px rgba(0, 0, 0, .32)",
    boxShadow3: "0 26px 72px rgba(0, 0, 0, .4)"
  },
  Button: {
    fontWeight: "600",
    borderRadiusMedium: "12px",
    borderRadiusLarge: "14px"
  },
  Input: {
    borderHover: "1px solid rgba(50, 170, 255, .5)",
    borderFocus: "1px solid #32aaff",
    boxShadowFocus: "0 0 0 2px rgba(50, 170, 255, .15)"
  },
  Select: { peers: { InternalSelection: { borderRadius: "12px" } } },
  DataTable: {
    thColor: "#24262a",
    tdColor: "transparent",
    tdColorHover: "rgba(50, 170, 255, .07)",
    borderColor: "transparent",
    thTextColor: "#a4a7ac",
    tdTextColor: "#d9dbde"
  },
  Tabs: {
    tabTextColorLine: "#a4a7ac",
    tabTextColorActiveLine: "#f3f4f5",
    barColor: "#32aaff"
  },
  Modal: { color: "#1c1d20", borderRadius: "18px" },
  Drawer: { color: "#1c1d20" },
  Notification: { color: "#1c1d20" }
};
