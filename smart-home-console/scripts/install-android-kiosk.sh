#!/usr/bin/env bash
set -euo pipefail

ADB="${ADB:-adb}"
APK="${1:-android/app/build/outputs/apk/debug/app-debug.apk}"
PACKAGE="${SMART_LAB_PACKAGE:-cn.zhijing.smartlab.debug}"
COMPONENT="$PACKAGE/cn.zhijing.smartlab.KioskActivity"

if [[ ! -f "$APK" ]]; then
  echo "APK 不存在：$APK" >&2
  exit 1
fi

"$ADB" get-state >/dev/null
"$ADB" install -r "$APK"
"$ADB" shell cmd package set-home-activity --user 0 "$COMPONENT"
"$ADB" shell am start -a android.intent.action.MAIN -c android.intent.category.HOME

home="$($ADB shell cmd shortcut get-default-launcher 2>/dev/null | tr -d '\r' || true)"
if [[ "$home" != *"$PACKAGE"* ]]; then
  echo "默认 HOME 未切换到 $PACKAGE；请检查设备厂商 Kiosk/默认桌面策略。" >&2
  exit 1
fi

echo "已安装并设置为默认 HOME：$home"
echo "首次启动请选择主屏或副屏角色；主屏需设置工程管理 PIN。"
