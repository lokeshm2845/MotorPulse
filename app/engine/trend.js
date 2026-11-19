// Trend engine (EWMA + one-sided CUSUM on falling health) and the severity rule table.
import { CRITICAL } from "./faults.js";

export const TREND = { alpha: 0.4, k: 4, h: 20 };

/**
 * @param healths chronological health scores, newest last
 * @returns {{ewma:number[], cusum:number[], alarm:boolean}}
 */
export function trend(healths) {
  const ewma = [], cusum = [];
  if (!healths.length) return { ewma, cusum, alarm: false };
  const ref = healths.slice(0, 3).reduce((a, b) => a + b, 0) / Math.min(3, healths.length);
  let e = healths[0], s = 0;
  for (const h of healths) {
    e = TREND.alpha * h + (1 - TREND.alpha) * e;
    s = Math.max(0, s + (ref - h - TREND.k));
    ewma.push(e); cusum.push(s);
  }
  return { ewma, cusum, alarm: healths.length >= 3 && s >= TREND.h };
}

/**
 * Severity rules (initial thresholds, tuned on field data later).
 * GREEN  health >= 75 and no trend alarm
 * YELLOW health 50-75, or a confirmed falling trend
 * RED    health < 50, or a critical fault hint (>= 0.7) on an abnormal recording
 */
export function severity(health, trendAlarm, hints) {
  const top = hints && hints[0];
  if (health < 50) return "red";
  if (health < 75 && top && CRITICAL.has(top.id) && top.confidence >= 0.7) return "red";
  if (health < 75 || trendAlarm) return "yellow";
  return "green";
}
