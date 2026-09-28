// 结束时间预演（纯函数，仅在控制台本地计算，不产生任何 WebSocket 指令）
//
// 场景：当前环节运行（running）或暂停（paused）时，输入“预计再持续 N 分钟”，
// 在本地模拟其最终结束点，并给出后续环节的模拟起止与相对现场（最新权威快照 +
// 运行中本地插值）的变化。
//
// 推演口径与服务端“结束本环节 / 进入下一环节”（advance）完全一致——直接复用服务端
// 权威纯函数：
//  - projectAgenda：普通环节背靠背顺延 / 提前、📌 固定环节锚定计划点、
//    固定点前“时间不足”压缩、跨午夜线性值；
//  - buildOccupancy：设备占用区间与周转冲突（跨午夜线性展开、最早冲突排序）。
// 因此预演对固定环节压缩、跨午夜时间和设备周转的判定与现场逐帧结果必然同口径。
//
// 模拟方式：把当前环节视为“在 now + 再持续分钟”这一时刻结束，即当前环节已用时长
// = 现场已用（elapsedMs，运行中随插值增长、暂停冻结） + extraMs，以 overdue 方式
// 调用 projectAgenda（结束点 = 实际开始点 + 总已用时长，不再假设准时结束）。
// 进入当前环节时携带的偏差 devIn 直接从现场行反推（固定环节恒为 0）。

import { projectAgenda } from '../../server/src/agenda.js';
import { buildOccupancy } from '../../server/src/devices.js';

export const MAX_REHEARSE_MIN = 24 * 60;

// 解析“预计再持续分钟数”输入：允许 0.1 分钟粒度（与议程时长/周转缓冲一致）。
// 返回整数毫秒；空串/非法/越界返回 { error }。
export function parseExtraMinutes(raw) {
  if (raw === '' || raw == null) return { error: 'empty' };
  const min = Number(raw);
  if (!Number.isFinite(min)) return { error: '请输入数字' };
  if (min < 0) return { error: '分钟数不能为负' };
  if (min > MAX_REHEARSE_MIN) return { error: `最多预演 ${MAX_REHEARSE_MIN} 分钟` };
  return { extraMs: Math.round(min * 60_000) };
}

// 从现场推演行反推“进入当前环节时携带的偏差”（devInMs）：
// 固定环节恒为 0；普通环节 = 预计开始 - 计划开始。
export function inferDevIn(row) {
  if (!row) return 0;
  return row.fixed ? 0 : row.projStartMs - row.startMs;
}

// 依据现场议程行与设备库做一次结束时间预演（纯函数）。
//
// 入参：
//   liveRows   现场（liveAgenda 插值后的）agenda.items
//   currentId  当前环节 id（必须能在 liveRows 中找到）
//   durationMs 当前倒计时采用的总时长（snap.durationMs）
//   elapsedMs  当前环节现场已用毫秒（运行中为插值实时值；暂停为冻结值）
//   extraMs    预计再持续毫秒（>=0）
//   devices    规范化设备库（devices 消息中的 { id, name, turnaroundMs, itemIds }）
// 返回：
//   { index, curEndMs, rows, occupancy, conflicts, diff: { added, worsened, improved } }
// rows 从当前行起按议程顺序排列；每行 deltaStartMs/deltaEndMs = 模拟 - 现场。
export function rehearse({ liveRows, currentId, durationMs, elapsedMs, extraMs, devices = [] }) {
  const rows = Array.isArray(liveRows) ? liveRows : [];
  const index = rows.findIndex((r) => r.id === currentId);
  if (index === -1) return null;

  const curLive = rows[index];
  const simElapsedMs = Math.max(0, elapsedMs) + Math.max(0, extraMs);

  // 复用权威推演：overdue=true 时当前环节结束点 = 实际开始点 + simElapsedMs，
  // 后续顺延/固定点压缩与现场 advance 后的计算路径完全相同。
  const projected = projectAgenda(rows, {
    currentId,
    devInMs: inferDevIn(curLive),
    virtElapsedMs: simElapsedMs,
    liveDurationMs: durationMs || curLive.durationMs,
    overdue: true,
  });

  const simRows = projected.slice(index).map((r) => {
    const live = rows.find((x) => x.id === r.id);
    return {
      ...r,
      deltaStartMs: live ? r.projStartMs - live.projStartMs : 0,
      deltaEndMs: live ? r.projEndMs - live.projEndMs : 0,
    };
  });

  // 设备周转冲突：现场与模拟使用同一份 buildOccupancy（跨午夜线性展开规则相同），
  // 仅传入的议程行不同，保证“冲突所据区间”与面板看到的时间严格一致。
  const liveOcc = buildOccupancy(devices, rows);
  const simOcc = buildOccupancy(devices, projected);

  const liveByKey = new Map(liveOcc.conflicts.map((c) => [conflictKey(c), c]));
  const simByKey = new Map(simOcc.conflicts.map((c) => [conflictKey(c), c]));

  const added = []; // 模拟后相对现场新增的冲突
  const worsened = []; // 现场已有、模拟后缺口增大（shortfall 变大）的冲突
  const improved = []; // 现场已有、模拟后缺口缩小或消解（供参考，非要求项）
  for (const [key, c] of simByKey) {
    const before = liveByKey.get(key);
    if (!before) added.push(c);
    else if (c.shortfallMs - before.shortfallMs > 0) worsened.push(c);
    else if (c.shortfallMs - before.shortfallMs < 0) improved.push(c);
  }
  for (const [key, c] of liveByKey) {
    if (!simByKey.has(key)) improved.push(c);
  }

  // 给模拟冲突打上相对现场的变化标记，供面板按同一口径标红
  const addedKeys = new Set(added.map(conflictKey));
  const worseKeys = new Set(worsened.map(conflictKey));
  const conflicts = simOcc.conflicts.map((c) => {
    const key = conflictKey(c);
    const before = liveByKey.get(key) ?? null;
    return {
      ...c,
      change: addedKeys.has(key) ? 'added' : worseKeys.has(key) ? 'worse' : 'same',
      beforeShortfallMs: before ? before.shortfallMs : null,
    };
  });

  return {
    index,
    curEndMs: simRows[0].projEndMs,
    rows: simRows,
    occupancy: simOcc,
    conflicts,
    addedCount: added.length,
    worsenedCount: worsened.length,
    resolvedCount: improved.length,
  };
}

// 冲突唯一键：同一设备上相邻的两次占用（议程顺序唯一）。
export function conflictKey(c) {
  return `${c.deviceId}|${c.a.itemId}|${c.b.itemId}`;
}
