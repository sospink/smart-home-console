import type { CommandRecord } from "@smart-lab/contracts";

export function operationKey(deviceId: string, property: string) {
  return `${deviceId}.${property}`;
}

/** 快照中的命令按服务端新到旧排序；每个设备属性各自保留最新一条未决命令。 */
export function pendingCommandsByProperty(commands: CommandRecord[]): Record<string, CommandRecord> {
  const pending: Record<string, CommandRecord> = {};
  for (const command of commands) {
    const key = operationKey(command.deviceId, command.property);
    if (command.status === "pending" && !pending[key]) pending[key] = command;
  }
  return pending;
}

/** 兼容只需要设备级汇总的界面；同设备多属性并发时优先返回最新未决命令。 */
export function pendingCommandsByDevice(commands: CommandRecord[]): Record<string, CommandRecord> {
  const pending: Record<string, CommandRecord> = {};
  for (const command of Object.values(pendingCommandsByProperty(commands))) {
    if (!pending[command.deviceId]) pending[command.deviceId] = command;
  }
  return pending;
}
