'use strict';

/**
 * Turn structured results into things the voice can use: a short spoken
 * confirmation for a completed command, or a context block for the brain to
 * phrase when live data was fetched.
 *
 * Keeping this here (pure + tested) means the router in main.js just wires
 * results to speech without a pile of string-building inline.
 */

function launchSpeech(r) {
  if (!r || !r.ok) return (r && r.error) || "I couldn't do that.";
  return `Opening ${r.describe || r.app || 'it'}.`;
}

function videoSpeech(r) {
  if (!r || !r.ok) return (r && r.error) || "I couldn't play that.";
  switch (r.kind) {
    case 'search':
      return 'Here you go.';
    case 'pause':
      return 'Paused.';
    case 'resume':
      return 'Resumed.';
    case 'volume':
      return 'Done.';
    default:
      return 'Done.';
  }
}

function spotifySpeech(r) {
  if (!r || !r.ok) return (r && r.error) || "I couldn't do that.";
  switch (r.action) {
    case 'play': {
      const by = r.artists && r.artists.length ? ` by ${r.artists.join(', ')}` : '';
      return `Playing ${r.track}${by}.`;
    }
    case 'pause':
      return 'Paused.';
    case 'resume':
      return 'Resumed.';
    case 'next':
      return 'Skipping ahead.';
    case 'previous':
      return 'Going back.';
    case 'volume':
      return `Volume ${r.volume} percent.`;
    default:
      return 'Done.';
  }
}

/**
 * Format a search result into a compact context block for the brain, or '' if
 * there's nothing useful to inject.
 */
function searchToContext(r) {
  if (!r || r.source === 'none') return '';
  switch (r.source) {
    case 'weather':
      return `Weather in ${r.location}: ${r.description}, ${r.tempC}°C (feels like ${r.feelsLikeC}°C), humidity ${r.humidity}%.`;
    case 'market':
      return `${r.symbol} price: ${r.price} ${r.currency} (previous close ${r.previousClose}).`;
    case 'instagram':
      return `${r.username}${r.fullName ? ` (${r.fullName})` : ''} has ${r.followers} Instagram followers.`;
    default: {
      const items = (r.results || [])
        .slice(0, 5)
        .map((x, i) => `${i + 1}. ${x.title} — ${x.snippet}`)
        .join('\n');
      return items ? `Search results for "${r.query}":\n${items}` : '';
    }
  }
}

module.exports = { launchSpeech, videoSpeech, spotifySpeech, searchToContext };
