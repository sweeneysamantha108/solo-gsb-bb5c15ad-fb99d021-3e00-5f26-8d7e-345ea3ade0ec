import { useEffect, useMemo, useRef, useState } from 'react';
import { formatClock } from '../time.js';
import { parseExtraMinutes, rehearse } from '../rehearse.js';

// 控制台“结束时间预演”面板：
//  - 仅当前环节处于运行(running)/暂停(paused)时可输入；
//  - 输入预计再持续的分钟数，依据最新权威快照（运行中在两份快照间本地插值）
//    模拟当前环节的最终结束点，展示当前及后续环节的模拟起止与相对现场的变化；
//  - 模拟直接复用服务端 projectAgenda（顺延/固定点压缩/跨午夜）与
//    buildOccupancy（设备占用/跨午夜/周转冲突）纯函数，只在本地计算——
//    不发送任何指令，不改动计时、议程与投屏；
//  - 当前环节切换（currentId/epoch 变化）或断线重连（epoch/连接态变化）后，
//    由父组件更换 basisKey 清空旧输入并按新快照重新计算。

const PRESETS = [5, 10, 15, 30];

function fmtDelta(ms) {
  if (ms == null || !Number.isFinite(ms) || Math.abs(ms) < 1000) return '—';
  const sign = ms < 0 ? '-' : '+';
  const abs = Math.abs(ms);
  const min = Math.round(abs / 60000);
  if (min >= 1) return `${sign}${min} 分`;
  return `${sign}${Math.round(abs / 1000)} 秒`;
}

function deltaClass(ms) {
  if (ms == null || Math.abs(ms) < 1000) return 'reh-delta-flat';
  return ms > 0 ? 'reh-delta-late' : 'reh-delta-early';
}

// 缺口/空当毫秒格式化（与 DevicePanel 口径一致）：正数“间隔 5 分”，0“背靠背”，负数“重叠 3 分”
function formatGap(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const abs = Math.abs(ms);
  if (abs < 1000) return '背靠背';
  const min = Math.round(abs / 60000);
  const text = min >= 1 ? `${min} 分` : `${Math.round(abs / 1000)} 秒`;
  return ms < 0 ? `重叠 ${text}` : `间隔 ${text}`;
}

// 缺口分钟数（还需补多少周转缓冲）
function formatShortfall(ms) {
  if (ms == null || ms <= 0) return null;
  const min = Math.round(ms / 60000);
  return min >= 1 ? `缺口 ${min} 分` : `缺口 ${Math.round(ms / 1000)} 秒`;
}

export default function RehearsalPanel({
  snap,
  liveAgendaRows,
  currentId,
  elapsedMs,
  devices,
  basisKey,
}) {
  const [raw, setRaw] = useState('');

  // 当前环节切换 / 服务纪元变化（重启）/ 断线重连后清空旧输入，重新按新快照计算
  useEffect(() => { setRaw(''); }, [basisKey]);

  const phase = snap?.phase ?? 'idle';
  const active = phase === 'running' || phase === 'paused';
  const wasActiveRef = useRef(active);

  // 退出可预演状态（重置回待开始、超时停表、当前环节被清空）时同样清空输入，
  // 避免恢复运行后沿用脱离当前快照的旧分钟数。
  useEffect(() => {
    if (wasActiveRef.current && !active) setRaw('');
    wasActiveRef.current = active;
  }, [active]);
  const liveRows = liveAgendaRows ?? [];
  const curIdx = liveRows.findIndex((r) => r.id === currentId);
  const curLive = curIdx >= 0 ? liveRows[curIdx] : null;

  // 现场设备冲突（与“设备占用”面板同源，随快照逐帧）
  const liveConflictKeys = new Set((devices?.conflicts ?? []).map((c) => `${c.deviceId}|${c.a.itemId}|${c.b.itemId}`));
  const liveConflictCount = liveConflictKeys.size;

  const parsed = raw === '' ? null : parseExtraMinutes(raw);
  const inputError = parsed?.error;
  const showResult = active && !!curLive && parsed && !parsed.error;

  const result = useMemo(() => {
    if (!showResult || !snap) return null;
    return rehearse({
      liveRows,
      currentId,
      durationMs: snap.durationMs,
      elapsedMs,
      extraMs: parsed.extraMs,
      devices: (devices?.devices ?? []).map((d) => ({
        id: d.id,
        name: d.name,
        turnaroundMs: d.turnaroundMs,
        itemIds: d.itemIds,
      })),
    });
  }, [showResult, snap, liveRows, currentId, elapsedMs, parsed?.extraMs, devices]);

  // 暂不可用时的提示（待开始/超时后重新开始前/已结束，均不允许预演）
  let unavailableHint = '';
  if (!active) {
    unavailableHint = currentId
      ? '当前环节未在运行或暂停（待开始 / 已超时停表），开始或暂停后可预演其结束点。'
      : '尚未设定当前环节：请先在“议程偏差推演”中点“设为当前”。';
  } else if (!curLive) {
    unavailableHint = '当前环节在最新快照中不存在（议程可能已被改写）。';
  }

  return (
    <fieldset className="panel reh-panel">
      <legend>
        结束时间预演（本地模拟，不改计时 / 议程 / 投屏；复用议程推演与设备周转规则）
      </legend>

      <div className="reh-input-row">
        <label className="reh-input-label">
          预计再持续
          <input
            type="number"
            min="0"
            max="1440"
            step="0.1"
            value={raw}
            disabled={!active || !curLive}
            placeholder="分钟"
            onChange={(e) => setRaw(e.target.value)}
          />
          分钟
        </label>
        <span className="reh-presets">
          {PRESETS.map((m) => (
            <button
              type="button"
              key={m}
              className="btn btn-mini reh-preset"
              disabled={!active || !curLive}
              onClick={() => setRaw(String(m))}
            >
              +{m} 分
            </button>
          ))}
        </span>
        {raw !== '' && (
          <button type="button" className="btn btn-mini btn-ghost" onClick={() => setRaw('')}>
            清空
          </button>
        )}
      </div>

      {inputError && <p className="agenda-error">⚠ {inputError}</p>}
      {unavailableHint && <p className="hint">{unavailableHint}</p>}

      {showResult && result && (
        <>
          <div className="reh-summary">
            <span className="reh-summary-item">
              模拟结束点 <b className="reh-end-time">{formatClock(result.curEndMs)}</b>
            </span>
            <span className="reh-summary-item">
              现场预计结束 <b>{formatClock(curLive.projEndMs)}</b>
            </span>
            <span className="reh-summary-item">
              设备周转冲突
              <b className={result.conflicts.length ? 'reh-conflict-bad' : 'reh-conflict-ok'}>
                {' '}{result.conflicts.length} 处
              </b>
            </span>
          </div>

          {/* 模拟后的设备周转冲突：标出相对现场新增或缺口增大者 */}
          {result.conflicts.length > 0 ? (
            <div className="reh-conflict-box">
              <div className="reh-conflict-head">
                ⚠ 模拟后周转冲突（现场 {liveConflictCount} 处 → 模拟 {result.conflicts.length} 处；
                <em className="reh-tag-new"> 新增 {result.addedCount}</em>
                <em className="reh-tag-worse"> 缺口增大 {result.worsenedCount}</em>
                {result.resolvedCount > 0 && <em className="reh-tag-ok"> 缩小/消解 {result.resolvedCount}</em>}
                ）
              </div>
              <ol className="reh-conflict-list">
                {result.conflicts.map((c) => (
                  <li
                    key={`${c.deviceId}-${c.a.itemId}-${c.b.itemId}`}
                    className={`reh-conflict-item ${c.change === 'added'
                      ? 'reh-conflict-added'
                      : c.change === 'worse'
                        ? 'reh-conflict-worse'
                        : ''}`}
                  >
                    {c.change === 'added' && <span className="reh-badge reh-badge-new">新增</span>}
                    {c.change === 'worse' && <span className="reh-badge reh-badge-worse">缺口增大</span>}
                    {c.change === 'same' && <span className="reh-badge reh-badge-same">现场已有</span>}
                    <span className="reh-conflict-device">🎤 {c.deviceName}</span>
                    <span className="reh-conflict-pair">
                      <b>{c.a.itemName}</b>
                      <em className="reh-conflict-arrow">→</em>
                      <b>{c.b.itemName}</b>
                    </span>
                    <span className="reh-conflict-gap">{formatGap(c.gapMs)}</span>
                    <span className="reh-conflict-short">
                      {formatShortfall(c.shortfallMs)}
                      {c.change === 'worse' && c.beforeShortfallMs != null && (
                        <em className="reh-short-delta">（原 {formatShortfall(c.beforeShortfallMs)}）</em>
                      )}
                    </span>
                    <span className="reh-conflict-time">后者 {formatClock(c.b.startMs)} 开始</span>
                  </li>
                ))}
              </ol>
            </div>
          ) : (
            <p className="hint reh-no-conflict">模拟后各设备相邻占用均满足周转缓冲，无周转冲突。</p>
          )}

          {/* 当前及后续环节：模拟起止 + 相对现场预计变化 */}
          <div className="reh-table" role="table">
            <div className="reh-row reh-head" role="row">
              <span>#</span>
              <span>环节</span>
              <span>现场预计起止</span>
              <span>模拟起止</span>
              <span>开始变化</span>
              <span>结束变化</span>
            </div>
            {result.rows.map((r, i) => {
              const live = liveRows.find((x) => x.id === r.id);
              return (
                <div
                  key={r.id}
                  className={`reh-row ${i === 0 ? 'reh-row-current' : ''} ${r.insufficient ? 'reh-row-short' : ''}`}
                  role="row"
                >
                  <span className="reh-idx">{r.itemIndex ?? result.index + i}</span>
                  <span className="reh-name">
                    {r.name}
                    {r.fixed && <em className="reh-pin" title="固定开始环节">📌</em>}
                    {i === 0 && <em className="tag tag-now">当前</em>}
                    {r.insufficient && <em className="tag tag-short">时间不足</em>}
                  </span>
                  <span className="reh-range">
                    {live ? `${formatClock(live.projStartMs)} – ${formatClock(live.projEndMs)}` : '—'}
                  </span>
                  <span className="reh-range reh-range-sim">
                    {formatClock(r.projStartMs)} – {formatClock(r.projEndMs)}
                  </span>
                  <span className={`reh-delta ${deltaClass(r.deltaStartMs)}`}>{fmtDelta(r.deltaStartMs)}</span>
                  <span className={`reh-delta ${deltaClass(r.deltaEndMs)}`}>{fmtDelta(r.deltaEndMs)}</span>
                </div>
              );
            })}
          </div>

          <p className="hint">
            模拟假设当前环节在已走时间基础上再持续 {String(raw)} 分钟后结束；📌 固定环节锚定计划点，
            前序溢出会压缩其前最后一个普通环节（标“时间不足”），跨午夜按同一线性时间轴比较。
            所有结果仅在本页本地计算，断线重连或切换当前环节后清空。
          </p>
        </>
      )}
    </fieldset>
  );
}
