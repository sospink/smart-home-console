import type { AlertRecord, Device } from "@smart-lab/contracts";

const levelPriority: Record<AlertRecord["level"], number> = {
  critical: 3,
  warning: 2,
  info: 1
};

/** 未恢复的告警仍属于活动异常；“确认”只记录操作员知悉。 */
export function activeAlerts(alerts: AlertRecord[]) {
  return alerts.filter((alert) => !alert.recoveredAt);
}

export function unacknowledgedAlerts(alerts: AlertRecord[]) {
  return activeAlerts(alerts).filter((alert) => !alert.acknowledgedAt);
}

/** 严重度优先；同严重度下，待确认优先于已确认待恢复，最后按发生时间排序。 */
export function featuredActiveAlert(alerts: AlertRecord[]) {
  return [...activeAlerts(alerts)].sort((left, right) => {
    const levelDifference = levelPriority[right.level] - levelPriority[left.level];
    if (levelDifference) return levelDifference;
    const acknowledgementDifference = Number(Boolean(left.acknowledgedAt)) - Number(Boolean(right.acknowledgedAt));
    if (acknowledgementDifference) return acknowledgementDifference;
    return Date.parse(right.occurredAt) - Date.parse(left.occurredAt);
  })[0];
}

export function alertRecoveryAvailability(alert: AlertRecord, devices: Device[]) {
  if (alert.recoveredAt) return { allowed: false, reason: "告警已恢复" };
  if (!alert.recoveryProperty) return { allowed: true, reason: "此告警需要管理员核实后手动恢复" };
  const device = devices.find((item) => item.id === alert.deviceId);
  if (alert.recoveryProperty === "__health") {
    return device?.health === alert.recoveryValue
      ? { allowed: true, reason: "设备已恢复在线，可结束运维事件" }
      : { allowed: false, reason: "设备仍未恢复在线，请检查供电、网关与通信链路" };
  }
  if (!device || device.health !== "online" || !(alert.recoveryProperty in device.state)) {
    return { allowed: false, reason: "恢复状态不可用，请先检查设备在线与属性上报" };
  }
  if (device.state[alert.recoveryProperty] !== alert.recoveryValue) {
    return { allowed: false, reason: "异常条件仍存在，请先排除现场故障" };
  }
  return { allowed: true, reason: "设备已上报异常解除，可结束告警" };
}
