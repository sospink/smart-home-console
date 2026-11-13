#!/usr/bin/env bash
set -euo pipefail

ADB="${ADB:-adb}"
BASE_APK="${1:?usage: verify-android-apk-lifecycle.sh BASE_APK UPGRADE_APK}"
UPGRADE_APK="${2:?usage: verify-android-apk-lifecycle.sh BASE_APK UPGRADE_APK}"
PACKAGE="${SMART_LAB_PACKAGE:-cn.zhijing.smartlab}"

for apk in "$BASE_APK" "$UPGRADE_APK"; do
  [[ -f "$apk" ]] || { echo "APK 不存在：$apk" >&2; exit 1; }
done

version_code() {
  "$ADB" shell dumpsys package "$PACKAGE" | sed -n 's/.*versionCode=\([0-9][0-9]*\).*/\1/p' | head -n 1 | tr -d '\r'
}

"$ADB" get-state >/dev/null
"$ADB" install -r "$BASE_APK" >/dev/null
base_code="$(version_code)"
"$ADB" install -r "$UPGRADE_APK" >/dev/null
upgrade_code="$(version_code)"
[[ "$upgrade_code" -gt "$base_code" ]] || { echo "升级包 versionCode 未增加" >&2; exit 1; }

"$ADB" install -r -d "$BASE_APK" >/dev/null
rollback_code="$(version_code)"
[[ "$rollback_code" == "$base_code" ]] || { echo "回滚后 versionCode 不一致" >&2; exit 1; }

"$ADB" install -r "$UPGRADE_APK" >/dev/null
final_code="$(version_code)"
[[ "$final_code" == "$upgrade_code" ]] || { echo "恢复升级版失败" >&2; exit 1; }

echo "APK 生命周期验证通过：$base_code -> $upgrade_code -> $base_code -> $upgrade_code"
echo "install -r/-d 不清除应用数据；还需由业务健康探针复核角色、场景和配置。"
