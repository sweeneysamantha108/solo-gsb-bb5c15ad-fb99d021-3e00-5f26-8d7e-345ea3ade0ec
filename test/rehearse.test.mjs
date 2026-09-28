// 结束时间预演纯函数单测：node test/rehearse.test.mjs
// 覆盖：输入解析、普通顺延、固定点压缩、跨午夜、设备周转冲突
//       （新增 / 缺口增大 / 已冲突不变）、当前行模拟结束点。
import assert from 'node:assert/strict';
import { projectAgenda, DAY_MS } from '../server/src/agenda.js';
import { rehearse, parseExtraMinutes, inferDevIn } from '../client/src/rehearse.js';

let n = 0;
const check = (name, fn) => { fn(); n += 1; console.log(`  ✓ ${name}`); };

const H = (h, m = 0) => ((h * 60 + m) * 60) * 1000;
const MIN = 60_000;

const mk = (id, name, h, m, durMin, fixed = false) => ({
  id, name, startMs: H(h, m), durationMs: durMin * MIN, fixed,
});

// 默认议程：A(当前 09:00 10min) → B 09:10 10min → C 09:30 固定 10min → D 09:40 10min
function liveView({ elapsedMin = 2, liveDurationMin = 10, overdue = false, devInMin = 0 } = {}) {
  const items = [
    mk('a', 'A', 9, 0, 10),
    mk('b', 'B', 9, 10, 10),
    mk('c', 'C', 9, 30, 10, true),
    mk('d', 'D', 9, 40, 10),
  ];
  return projectAgenda(items, {
    currentId: 'a',
    devInMs: devInMin * MIN,
    virtElapsedMs: elapsedMin * MIN,
    liveDurationMs: liveDurationMin * MIN,
    overdue,
  });
}

check('parseExtraMinutes：空/非数字/负数/越界拒绝，0.1 分钟粒度取整毫秒', () => {
  assert.equal(parseExtraMinutes('').error, 'empty');
  assert.ok(parseExtraMinutes('abc').error);
  assert.ok(parseExtraMinutes(-1).error);
  assert.ok(parseExtraMinutes(1441).error);
  assert.equal(parseExtraMinutes(0).extraMs, 0);
  assert.equal(parseExtraMinutes('5').extraMs, 5 * MIN);
  assert.equal(parseExtraMinutes('0.1').extraMs, 6000);
});

check('运行中再持续 N 分钟：当前结束点 = 开始 + 已用 + N，后续普通环节顺延', () => {
  // 已运行 2 分钟（现场假设 09:10 准时结束），预演再持续 13 分钟 → 09:15 结束
  const rows = liveView({ elapsedMin: 2 });
  const r = rehearse({
    liveRows: rows, currentId: 'a', durationMs: 10 * MIN,
    elapsedMs: 2 * MIN, extraMs: 13 * MIN, devices: [],
  });
  assert.equal(r.curEndMs, H(9, 15));
  assert.equal(r.rows[1].projStartMs, H(9, 15)); // B 顺延到 09:15
  assert.equal(r.rows[1].projEndMs, H(9, 25));
  assert.equal(r.rows[1].deltaStartMs, 5 * MIN);
  assert.equal(r.rows[2].projStartMs, H(9, 30)); // C 固定不动
  assert.equal(r.rows[2].deltaStartMs, 0);
});

check('固定环节压缩：再持续到溢出固定点时，其前普通环节被压缩并标“时间不足”', () => {
  // 再持续 20 分钟：A 09:22 结束 → B 09:22~09:30 被夹到固定点 C
  const rows = liveView({ elapsedMin: 2 });
  const r = rehearse({
    liveRows: rows, currentId: 'a', durationMs: 10 * MIN,
    elapsedMs: 2 * MIN, extraMs: 20 * MIN, devices: [],
  });
  assert.equal(r.curEndMs, H(9, 22));
  const b = r.rows.find((x) => x.id === 'b');
  assert.equal(b.projStartMs, H(9, 22));
  assert.equal(b.projEndMs, H(9, 30));
  assert.equal(b.effDurationMs, 8 * MIN);
  assert.equal(b.insufficient, true);
  const c = r.rows.find((x) => x.id === 'c');
  assert.equal(c.projStartMs, H(9, 30));
});

check('被压缩的可以是当前环节本身（当前普通环节后紧跟固定环节）', () => {
  const items = [mk('a', 'A', 9, 0, 10), mk('c', 'C', 9, 5, 10, true)];
  const rows = projectAgenda(items, {
    currentId: 'a', virtElapsedMs: 2 * MIN, liveDurationMs: 10 * MIN,
  });
  const r = rehearse({
    liveRows: rows, currentId: 'a', durationMs: 10 * MIN,
    elapsedMs: 2 * MIN, extraMs: 6 * MIN, devices: [],
  }); // A 物理上 09:08 才结束，撞上 09:05 固定点
  // 权威推演把当前普通环节本身夹到固定点（与 agenda.test 既有口径一致），并标“时间不足”
  assert.equal(r.curEndMs, H(9, 5));
  assert.equal(r.rows[0].projEndMs, H(9, 5));
  assert.equal(r.rows[0].insufficient, true);
});

check('跨午夜：固定当前环节超时后结束点线性越过 24:00，后续普通环节顺延到次日', () => {
  const items = [
    mk('a', 'A', 23, 50, 10, true), // 固定当前：projStart 恒为计划点
    mk('b', 'B', 0, 5, 10),         // 普通环节：背靠背顺延（线性越过 24:00）
  ];
  const rows = projectAgenda(items, {
    currentId: 'a', virtElapsedMs: 0, liveDurationMs: 10 * MIN,
  });
  // 现场假设 A 24:00 结束、B 次日 00:00 开始；预演再持续 20 分钟 → A 次日 00:10 结束
  const r = rehearse({
    liveRows: rows, currentId: 'a', durationMs: 10 * MIN,
    elapsedMs: 0, extraMs: 20 * MIN, devices: [],
  });
  assert.equal(r.curEndMs, DAY_MS + 10 * MIN);
  const b = r.rows.find((x) => x.id === 'b');
  assert.equal(b.projStartMs, DAY_MS + 10 * MIN);
  assert.equal(b.projEndMs, DAY_MS + 20 * MIN);
});

check('跨午夜设备冲突：23:50 固定环节与次日 00:00 后相邻占用按线性时间轴判定', () => {
  const items = [
    mk('a', 'A', 23, 50, 10, true),
    mk('b', 'B', 0, 5, 10),
  ];
  const rows = projectAgenda(items, {
    currentId: 'a', virtElapsedMs: 0, liveDurationMs: 10 * MIN,
  });
  const devices = [{ id: 'dn', name: '麦', turnaroundMs: 10 * MIN, itemIds: ['a', 'b'] }];
  // 现场（非 overdue 推演）假设 A 23:50~24:00、B 次日 00:00~00:10：背靠背，缓冲 10 分 → 冲突。
  // 预演 extra=10（已用 0 + 再持续 10 = 完整时长）复现现场准时结束点。
  const before = rehearse({
    liveRows: rows, currentId: 'a', durationMs: 10 * MIN,
    elapsedMs: 0, extraMs: 10 * MIN, devices,
  });
  assert.equal(before.conflicts.length, 1);
  assert.equal(before.conflicts[0].b.startMs, DAY_MS);
  assert.equal(before.conflicts[0].gapMs, 0);
  assert.equal(before.conflicts[0].shortfallMs, 10 * MIN);
  assert.equal(before.conflicts[0].change, 'same');
  // 再持续 20 分钟：A、B 整体平移到次日 00:10/00:20，仍背靠背——线性轴展开正确，冲突不增大
  const later = rehearse({
    liveRows: rows, currentId: 'a', durationMs: 10 * MIN,
    elapsedMs: 0, extraMs: 20 * MIN, devices,
  });
  assert.equal(later.curEndMs, DAY_MS + 10 * MIN);
  assert.equal(later.conflicts[0].b.startMs, DAY_MS + 10 * MIN);
  assert.equal(later.conflicts[0].gapMs, 0);
  assert.equal(later.conflicts[0].change, 'same');
});

check('设备冲突：背靠背顺延时空当不变，冲突标记为 same（既不新增也不增大）', () => {
  const rows = liveView({ elapsedMin: 2 });
  const devices = [{ id: 'd1', name: '麦', turnaroundMs: 10 * MIN, itemIds: ['a', 'b'] }];
  // 现场（非 overdue）：A 09:10 结束、B 09:10 开始，背靠背，缓冲 10 分 → 已有 1 处冲突（缺口 10）。
  // 预演 extra=8（已用 2 + 再持续 8 = 完整时长）复现现场准时结束点。
  const before = rehearse({
    liveRows: rows, currentId: 'a', durationMs: 10 * MIN,
    elapsedMs: 2 * MIN, extraMs: 8 * MIN, devices,
  });
  assert.equal(before.conflicts.length, 1);
  assert.equal(before.addedCount, 0);
  assert.equal(before.worsenedCount, 0);

  // 再持续 13 分钟：A 09:15 结束、B 09:15 开始；两者仍背靠背，缺口仍是 10 分（same）
  const same = rehearse({
    liveRows: rows, currentId: 'a', durationMs: 10 * MIN,
    elapsedMs: 2 * MIN, extraMs: 13 * MIN, devices,
  });
  assert.equal(same.conflicts[0].change, 'same');
  assert.equal(same.conflicts[0].gapMs, 0);
  assert.equal(same.addedCount, 0);
  assert.equal(same.worsenedCount, 0);
});

check('设备冲突：继续延后压缩空当 → 相对现场缺口增大（worse）', () => {
  // 设备绑定 B 与 C：现场 B 09:10~09:20、C 固定 09:30，间隔 10 分，缓冲 15 分 → 已冲突（缺 5）
  const rows = liveView({ elapsedMin: 2 });
  const devices = [{ id: 'd2', name: '箱', turnaroundMs: 15 * MIN, itemIds: ['b', 'c'] }];
  const before = rehearse({
    liveRows: rows, currentId: 'a', durationMs: 10 * MIN,
    elapsedMs: 2 * MIN, extraMs: 8 * MIN, devices,
  }); // 复现现场准时结束点
  assert.equal(before.conflicts.length, 1);
  assert.equal(before.conflicts[0].shortfallMs, 5 * MIN);

  // 再持续 18 分钟（额外比复现点多 10）：B 09:20~09:30（被固定点夹到 10 分钟），与 C 背靠背，
  // 空当 0，缺口 15 分（>5）→ 缺口增大
  const worse = rehearse({
    liveRows: rows, currentId: 'a', durationMs: 10 * MIN,
    elapsedMs: 2 * MIN, extraMs: 18 * MIN, devices,
  });
  assert.equal(worse.conflicts.length, 1);
  assert.equal(worse.conflicts[0].change, 'worse');
  assert.equal(worse.conflicts[0].gapMs, 0);
  assert.equal(worse.conflicts[0].shortfallMs, 15 * MIN);
  assert.equal(worse.conflicts[0].beforeShortfallMs, 5 * MIN);
  assert.equal(worse.worsenedCount, 1);
});

check('设备冲突：现场无冲突的相邻占用，模拟后缓冲不足 → 新增冲突', () => {
  const rows = liveView({ elapsedMin: 2 });
  // 现场 A 09:00~09:10、D 09:40 开始（中间隔着 B 与固定 C，但设备只在 A、D 间比较，
  // buildOccupancy 仅取真正相邻的两次绑定占用）：间隔 30 分，缓冲 25 分，无冲突。
  const devices = [{ id: 'd4', name: '麦2', turnaroundMs: 25 * MIN, itemIds: ['a', 'd'] }];
  const before = rehearse({
    liveRows: rows, currentId: 'a', durationMs: 10 * MIN,
    elapsedMs: 2 * MIN, extraMs: 0, devices,
  });
  assert.equal(before.conflicts.length, 0);

  // 再持续 30 分钟：A 物理结束 09:32；B 09:32 起后撞上固定 C(09:30)，被夹到 09:32~09:30；
  // A 本身保持 09:32 结束（被压缩的是其与固定点之间的 B）。D 仍 09:40 开始，
  // A 与 D 间隔仅 8 分 < 25 → 新增冲突（缺口 17 分）。
  const added = rehearse({
    liveRows: rows, currentId: 'a', durationMs: 10 * MIN,
    elapsedMs: 2 * MIN, extraMs: 30 * MIN, devices,
  });
  assert.equal(added.conflicts.length, 1);
  assert.equal(added.conflicts[0].change, 'added');
  assert.equal(added.addedCount, 1);
  assert.equal(added.conflicts[0].a.itemId, 'a');
  assert.equal(added.conflicts[0].b.itemId, 'd');
  assert.equal(added.conflicts[0].gapMs, 8 * MIN);
  assert.equal(added.conflicts[0].shortfallMs, 17 * MIN);
});

check('暂停（携带顺延偏差）：devIn 从现场行反推，模拟在冻结已用基础上延续', () => {
  // 上一固定环节后已顺延 +4 分钟进入 A（普通），A 暂停在已用 3 分钟处
  const rows = liveView({ elapsedMin: 3, devInMin: 4 });
  assert.equal(inferDevIn(rows[0]), 4 * MIN);
  // 现场 A 实际开始 09:04；预演再持续 10 分钟 → 09:17 结束
  const r = rehearse({
    liveRows: rows, currentId: 'a', durationMs: 10 * MIN,
    elapsedMs: 3 * MIN, extraMs: 10 * MIN, devices: [],
  });
  assert.equal(r.curEndMs, H(9, 17));
  assert.equal(r.rows[0].projStartMs, H(9, 4));
});

check('currentId 不存在 / 空议程：返回 null', () => {
  assert.equal(rehearse({ liveRows: liveView(), currentId: 'zzz', elapsedMs: 0, extraMs: 1 }), null);
  assert.equal(rehearse({ liveRows: [], currentId: 'a', elapsedMs: 0, extraMs: 1 }), null);
});

console.log(`\n结束时间预演纯函数测试：${n} 通过，0 失败`);
