import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { RotateCw, AlertTriangle, Zap, Hash, Timer, ShieldAlert, ChevronLeft, ChevronRight } from 'lucide-react';
import { ANALYTICS_API_URL } from '../config/api';
import './UsageAnalyticsPane.css';

// Fixed categorical palette (same accent set used elsewhere in Settings) —
// assigned by a stable hash of the key, never by array position, so the
// same model/usage-type always gets the same color across filter changes.
const PALETTE = ['#818cf8', '#34d399', '#fbbf24', '#fb7185', '#60a5fa', '#a78bfa', '#f97316', '#2dd4bf'];
function colorFor(key) {
  let h = 0;
  const s = String(key || 'unknown');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

const MODE_LABELS = {
  chat: 'Chat', learn: 'Learn Mode', news_agent: 'News Agent', quiz: 'Quiz', exam: 'Exam',
};
const prettyMode = (m) => MODE_LABELS[m] || (m ? m.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : 'Unknown');
const prettyModel = (m) => (m ? m.split('/').pop().replace(':free', '') : 'Unknown');

function todayISO() { return new Date().toISOString().slice(0, 10); }
function daysAgoISO(n) { return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10); }

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export default function UsageAnalyticsPane({ user }) {
  const userId = user?.id;
  const [fromDate, setFromDate] = useState(daysAgoISO(30));
  const [toDate, setToDate] = useState(todayISO());
  const [model, setModel] = useState('all');
  const [sourceMode, setSourceMode] = useState('all');

  const [filterOptions, setFilterOptions] = useState({ models: [], source_modes: [] });
  const [summary, setSummary] = useState(null);
  const [points, setPoints] = useState([]);
  const [byModel, setByModel] = useState([]);
  const [byMode, setByMode] = useState([]);
  const [logs, setLogs] = useState({ items: [], total: 0, page: 1, page_size: 10 });
  const [logPage, setLogPage] = useState(1);
  const [hoverPoint, setHoverPoint] = useState(null);

  const [loading, setLoading] = useState(false);
  const [serviceDown, setServiceDown] = useState(false);

  const qs = useCallback((extra = {}) => {
    const p = new URLSearchParams({ user_id: userId, from_date: fromDate, to_date: toDate, model, source_mode: sourceMode, ...extra });
    return p.toString();
  }, [userId, fromDate, toDate, model, sourceMode]);

  const loadAll = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    try {
      const [s, ts, bm, bmode, lg, filt] = await Promise.all([
        getJSON(`${ANALYTICS_API_URL}/api/analytics/summary?${qs()}`),
        getJSON(`${ANALYTICS_API_URL}/api/analytics/timeseries?${qs()}`),
        getJSON(`${ANALYTICS_API_URL}/api/analytics/by_model?${qs()}`),
        getJSON(`${ANALYTICS_API_URL}/api/analytics/by_mode?${qs()}`),
        getJSON(`${ANALYTICS_API_URL}/api/analytics/logs?${qs({ page: 1, page_size: 10 })}`),
        getJSON(`${ANALYTICS_API_URL}/api/analytics/filters?user_id=${userId}`),
      ]);
      setSummary(s);
      setPoints(ts.points || []);
      setByModel(bm.breakdown || []);
      setByMode(bmode.breakdown || []);
      setLogs(lg);
      setLogPage(1);
      setFilterOptions(filt);
      setServiceDown(false);
    } catch (err) {
      console.error('Usage analytics fetch failed:', err);
      setServiceDown(true);
    } finally {
      setLoading(false);
    }
  }, [userId, qs]);

  useEffect(() => { loadAll(); }, [loadAll]);

  const changePage = async (nextPage) => {
    if (nextPage < 1 || (logs.total && (nextPage - 1) * logs.page_size >= logs.total)) return;
    setLogPage(nextPage);
    try {
      const lg = await getJSON(`${ANALYTICS_API_URL}/api/analytics/logs?${qs({ page: nextPage, page_size: 10 })}`);
      setLogs(lg);
    } catch (err) {
      console.error('Failed to fetch usage log page:', err);
    }
  };

  const maxTokens = useMemo(() => Math.max(1, ...points.map(p => p.tokens)), [points]);
  const usedPct = summary?.used_pct ?? 0;
  const usedColor = usedPct <= 50 ? '#10b981' : usedPct <= 80 ? '#f59e0b' : '#ef4444';
  const totalPages = logs.total ? Math.ceil(logs.total / logs.page_size) : 1;

  if (!userId) {
    return <div className="usage-empty-state">Sign in to see your usage analytics.</div>;
  }

  return (
    <div className="settings-pane animate-fadeIn usage-pane">
      <div className="usage-pane-header">
        <h3 className="pane-title" style={{ marginBottom: 4 }}>Usage Analytics</h3>
        <button className="usage-refresh-btn" onClick={loadAll} disabled={loading} title="Refresh">
          <RotateCw size={14} className={loading ? 'spin-icon' : ''} />
        </button>
      </div>
      <p className="usage-pane-subtitle">Every AI call this account has made — filter by date, model, or feature.</p>

      {serviceDown && (
        <div className="usage-service-down">
          <AlertTriangle size={16} />
          <span>Can't reach the analytics service at <code>{ANALYTICS_API_URL}</code>. Start it with <code>npm run dev:analytics</code>.</span>
        </div>
      )}

      {/* Filters */}
      <div className="usage-filters">
        <label className="usage-filter-field">
          <span>From</span>
          <input type="date" value={fromDate} max={toDate} onChange={e => setFromDate(e.target.value)} />
        </label>
        <label className="usage-filter-field">
          <span>To</span>
          <input type="date" value={toDate} min={fromDate} max={todayISO()} onChange={e => setToDate(e.target.value)} />
        </label>
        <label className="usage-filter-field">
          <span>Model</span>
          <select value={model} onChange={e => setModel(e.target.value)}>
            <option value="all">All models</option>
            {filterOptions.models.map(m => <option key={m} value={m}>{prettyModel(m)}</option>)}
          </select>
        </label>
        <label className="usage-filter-field">
          <span>Usage type</span>
          <select value={sourceMode} onChange={e => setSourceMode(e.target.value)}>
            <option value="all">All types</option>
            {filterOptions.source_modes.map(m => <option key={m} value={m}>{prettyMode(m)}</option>)}
          </select>
        </label>
      </div>

      {/* Stat tiles */}
      <div className="usage-stat-grid">
        <div className="usage-stat-tile">
          <div className="usage-stat-icon" style={{ color: usedColor }}><Zap size={16} /></div>
          <div className="usage-stat-value" style={{ color: usedColor }}>{(summary?.total_tokens ?? 0).toLocaleString()}</div>
          <div className="usage-stat-label">Tokens used ({usedPct}% of {(summary?.limit ?? 200000).toLocaleString()})</div>
        </div>
        <div className="usage-stat-tile">
          <div className="usage-stat-icon" style={{ color: '#60a5fa' }}><Hash size={16} /></div>
          <div className="usage-stat-value">{(summary?.total_calls ?? 0).toLocaleString()}</div>
          <div className="usage-stat-label">AI calls</div>
        </div>
        <div className="usage-stat-tile">
          <div className="usage-stat-icon" style={{ color: '#a78bfa' }}><Timer size={16} /></div>
          <div className="usage-stat-value">{summary?.avg_latency_ms ?? 0}ms</div>
          <div className="usage-stat-label">Avg latency</div>
        </div>
        <div className="usage-stat-tile">
          <div className="usage-stat-icon" style={{ color: summary?.error_count ? '#ef4444' : '#34d399' }}><ShieldAlert size={16} /></div>
          <div className="usage-stat-value" style={{ color: summary?.error_count ? '#ef4444' : undefined }}>{summary?.error_count ?? 0}</div>
          <div className="usage-stat-label">Errors</div>
        </div>
      </div>

      {/* Daily usage chart */}
      <div className="usage-chart-card">
        <div className="usage-chart-title">Daily token usage</div>
        {points.length === 0 ? (
          <div className="usage-empty-state">No calls in this range.</div>
        ) : (
          <div className="usage-chart-scroll">
            <div className="usage-chart-bars">
              {points.map(p => (
                <div
                  key={p.date}
                  className="usage-bar-col"
                  onMouseEnter={() => setHoverPoint(p)}
                  onMouseLeave={() => setHoverPoint(null)}
                >
                  {hoverPoint?.date === p.date && (
                    <div className="usage-bar-tooltip">
                      <strong>{p.tokens.toLocaleString()}</strong> tokens · {p.calls} call{p.calls === 1 ? '' : 's'}
                      <div className="usage-bar-tooltip-date">{p.date}</div>
                    </div>
                  )}
                  <div
                    className="usage-bar"
                    style={{ height: `${Math.max(3, (p.tokens / maxTokens) * 100)}%` }}
                  />
                  <div className="usage-bar-label">{p.date.slice(5)}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Breakdowns */}
      <div className="usage-breakdown-grid">
        <div className="usage-breakdown-card">
          <div className="usage-chart-title">By model</div>
          {byModel.length === 0 && <div className="usage-empty-state">No data.</div>}
          {byModel.map(b => (
            <div className="usage-breakdown-row" key={b.model}>
              <span className="usage-breakdown-dot" style={{ background: colorFor(b.model) }} />
              <span className="usage-breakdown-label" title={b.model}>{prettyModel(b.model)}</span>
              <div className="usage-breakdown-bar-track">
                <div className="usage-breakdown-bar-fill" style={{ width: `${b.pct}%`, background: colorFor(b.model) }} />
              </div>
              <span className="usage-breakdown-pct">{b.pct}%</span>
            </div>
          ))}
        </div>
        <div className="usage-breakdown-card">
          <div className="usage-chart-title">By usage type</div>
          {byMode.length === 0 && <div className="usage-empty-state">No data.</div>}
          {byMode.map(b => (
            <div className="usage-breakdown-row" key={b.source_mode}>
              <span className="usage-breakdown-dot" style={{ background: colorFor(b.source_mode) }} />
              <span className="usage-breakdown-label">{prettyMode(b.source_mode)}</span>
              <div className="usage-breakdown-bar-track">
                <div className="usage-breakdown-bar-fill" style={{ width: `${b.pct}%`, background: colorFor(b.source_mode) }} />
              </div>
              <span className="usage-breakdown-pct">{b.pct}%</span>
            </div>
          ))}
        </div>
      </div>

      {/* Raw call log */}
      <div className="usage-chart-title" style={{ marginTop: 8 }}>Recent AI calls</div>
      <div className="usage-log-table-wrap">
        <table className="usage-log-table">
          <thead>
            <tr>
              <th>Date</th><th>Type</th><th>Model</th><th>Tokens</th><th>Latency</th><th>Status</th>
            </tr>
          </thead>
          <tbody>
            {logs.items.map(row => (
              <tr key={row.id}>
                <td>{row.created_at ? new Date(row.created_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'}</td>
                <td><span className="usage-mode-chip" style={{ color: colorFor(row.source_mode), borderColor: colorFor(row.source_mode) + '55' }}>{prettyMode(row.source_mode)}</span></td>
                <td className="usage-log-model" title={row.model}>{prettyModel(row.model)}</td>
                <td>{row.total_tokens.toLocaleString()} <span className="usage-log-split">({row.input_tokens}/{row.output_tokens})</span></td>
                <td>{row.latency_ms ? `${row.latency_ms}ms` : '—'}</td>
                <td>{row.error ? <span className="usage-status-error">Error</span> : <span className="usage-status-ok">OK</span>}</td>
              </tr>
            ))}
            {logs.items.length === 0 && (
              <tr><td colSpan={6} className="usage-empty-state">No calls in this range.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {logs.total > logs.page_size && (
        <div className="usage-pagination">
          <button onClick={() => changePage(logPage - 1)} disabled={logPage <= 1}><ChevronLeft size={14} /></button>
          <span>Page {logPage} of {totalPages}</span>
          <button onClick={() => changePage(logPage + 1)} disabled={logPage >= totalPages}><ChevronRight size={14} /></button>
        </div>
      )}
    </div>
  );
}
