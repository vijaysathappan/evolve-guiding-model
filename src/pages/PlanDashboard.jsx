import React, { useState, useEffect, useCallback } from 'react';
import { Calendar, RefreshCw, BookOpen, Target, Flame, TrendingUp, ChevronRight } from 'lucide-react';
import { API_BASE_URL } from '../config/api';

const KIND_META = {
  learn:   { label: 'Learn',    color: '#f0b341', desc: 'New chapter' },
  reteach: { label: 'Re-learn', color: '#e8833a', desc: 'Weak area' },
  practice:{ label: 'Practice', color: '#8fb996', desc: 'Consolidate' },
  revise:  { label: 'Revise',   color: '#7ea8be', desc: 'Keep retention' },
};

export default function PlanDashboard({ user, onOpenChapter }) {
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [generatedAt, setGeneratedAt] = useState(null);

  const fetchPlan = useCallback(async () => {
    if (!user?.id) return;
    setLoading(true);
    try {
      const resp = await fetch(`${API_BASE_URL}/api/plan/${user.id}`);
      const data = await resp.json();
      setTasks(data.tasks || []);
      setGeneratedAt(data.generated_at);
    } catch (err) {
      console.error('Failed to fetch plan:', err);
    } finally {
      setLoading(false);
    }
  }, [user?.id]);

  useEffect(() => { fetchPlan(); }, [fetchPlan]);

  const tracked = tasks.filter(t => t.mastery !== null);
  const avgMastery = tracked.length
    ? Math.round(tracked.reduce((a, t) => a + t.mastery, 0) / tracked.length * 100)
    : null;
  const weakest = tracked.length ? tracked.reduce((a, t) => (t.mastery < a.mastery ? t : a)) : null;

  return (
    <div className="animate-fadeIn" style={{ flex: 1, overflowY: 'auto', padding: '40px clamp(20px, 6vw, 80px)' }}>
      {/* Hero */}
      <header style={{ marginBottom: '32px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
          <span style={{ fontSize: '0.72rem', fontWeight: 800, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--accent-brand)', background: 'var(--bg-highlight)', border: '1px solid var(--border-color)', padding: '4px 12px', borderRadius: '999px' }}>
            Plan Mode
          </span>
          {generatedAt && (
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
              built {new Date(generatedAt).toLocaleTimeString()}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap' }}>
          <div>
            <h1 style={{ fontSize: 'clamp(1.7rem, 3.5vw, 2.6rem)', fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1.15 }}>
              Today's study plan
            </h1>
            <p style={{ color: 'var(--text-secondary)', marginTop: '6px', maxWidth: '540px' }}>
              Rebuilt from your knowledge graph after every quiz, exam and lesson —
              weakest, highest-weightage chapters float to the top.
            </p>
          </div>
          <button
            onClick={fetchPlan}
            style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 18px', borderRadius: '10px', background: 'var(--bg-surface)', border: '1px solid var(--border)', color: 'var(--text-secondary)', fontWeight: 600, fontSize: '0.85rem' }}
          >
            <RefreshCw size={14} className={loading ? 'spin' : ''} /> Re-plan
          </button>
        </div>
      </header>

      {/* Stat band */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '14px', marginBottom: '36px' }}>
        {[
          { icon: <Target size={16} />, label: 'Chapters tracked', value: tracked.length ? `${tracked.length} / ${tasks.length}` : `0 / ${tasks.length}` },
          { icon: <TrendingUp size={16} />, label: 'Average mastery', value: avgMastery !== null ? `${avgMastery}%` : '—' },
          { icon: <Flame size={16} />, label: 'Weakest chapter', value: weakest ? weakest.chapter_name : '—' },
          { icon: <Calendar size={16} />, label: 'Tasks scheduled', value: tasks.length },
        ].map((s, i) => (
          <div key={i} style={{ padding: '16px 18px', borderRadius: '14px', background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-muted)', fontSize: '0.72rem', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
              {s.icon} {s.label}
            </div>
            <div style={{ fontFamily: 'var(--font-serif)', fontSize: '1.25rem', color: 'var(--text-primary)', marginTop: '6px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {s.value}
            </div>
          </div>
        ))}
      </div>

      {/* Task list */}
      <h3 style={{ fontSize: '1.05rem', color: 'var(--text-primary)', marginBottom: '14px' }}>Priority queue</h3>
      {loading && <div style={{ color: 'var(--text-muted)', padding: '20px 0' }}>Building your plan…</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', maxWidth: '860px' }}>
        {tasks.map((t, idx) => {
          const meta = KIND_META[t.kind] || KIND_META.learn;
          const masteryPct = t.mastery !== null ? Math.round(t.mastery * 100) : null;
          return (
            <div
              key={t.id}
              onClick={() => onOpenChapter && onOpenChapter(t.subject, t.chapter_name)}
              style={{
                display: 'flex', alignItems: 'center', gap: '16px', padding: '16px 20px', cursor: 'pointer',
                borderRadius: '14px', background: 'var(--bg-card)', border: '1px solid var(--border)',
                borderLeft: `3px solid ${meta.color}`, transition: 'var(--transition-smooth)',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-card-hover)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'var(--bg-card)'; }}
            >
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem', color: 'var(--text-muted)', width: '22px' }}>{idx + 1}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '0.68rem', fontWeight: 800, letterSpacing: '0.1em', textTransform: 'uppercase', color: meta.color, background: `${meta.color}1e`, padding: '2px 10px', borderRadius: '999px' }}>
                    {meta.label}
                  </span>
                  <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{t.chapter_name}</span>
                  <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>{t.subject} · {t.pyq_weightage} PYQ weightage</span>
                </div>
                <div style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', marginTop: '4px' }}>{t.reason}</div>
                {/* Mastery bar */}
                <div style={{ marginTop: '10px', height: '5px', borderRadius: '3px', background: 'var(--bg-surface-hover)', maxWidth: '320px', overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${masteryPct ?? 0}%`, borderRadius: '3px', background: `linear-gradient(90deg, ${meta.color}, ${meta.color}aa)`, transition: 'width 0.6s cubic-bezier(0.16,1,0.3,1)' }} />
                </div>
              </div>
              <div style={{ textAlign: 'right', flexShrink: 0 }}>
                <div style={{ fontFamily: 'var(--font-serif)', fontSize: '1.15rem', color: masteryPct === null ? 'var(--text-muted)' : 'var(--text-primary)' }}>
                  {masteryPct === null ? 'new' : `${masteryPct}%`}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '0.72rem', color: 'var(--accent-brand)', fontWeight: 700 }}>
                  <BookOpen size={12} /> open <ChevronRight size={12} />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
