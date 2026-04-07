const fs = require('fs');
const path = require('path');
const semver = require('semver');

const GITHUB_LATEST_RELEASE =
  'https://api.github.com/repos/cellio-dev/trackflow/releases/latest';

function readLocalPackageVersion() {
  const pkgPath = path.join(__dirname, '..', 'package.json');
  const raw = fs.readFileSync(pkgPath, 'utf8');
  const pkg = JSON.parse(raw);
  return String(pkg.version || '0.0.0').trim() || '0.0.0';
}

function stripLeadingV(s) {
  const t = String(s || '').trim();
  if (t.startsWith('v') || t.startsWith('V')) {
    return t.slice(1);
  }
  return t;
}

/**
 * @returns {Promise<{
 *   current: string,
 *   latestTag: string,
 *   latestName: string | null,
 *   html_url: string | null,
 *   updateAvailable: boolean,
 *   comparable: boolean,
 *   relation: 'behind' | 'equal' | 'ahead' | null
 * }>}
 */
async function checkTrackflowUpdate() {
  const current = readLocalPackageVersion();

  let res;
  try {
    res = await fetch(GITHUB_LATEST_RELEASE, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'TrackFlow-UpdateCheck',
      },
    });
  } catch (e) {
    const msg = e?.message != null ? String(e.message) : '';
    throw new Error(msg ? `Update check failed: ${msg}` : 'Update check failed (network error).');
  }

  if (res.status === 404) {
    throw new Error('No GitHub releases found for TrackFlow yet.');
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GitHub API error (${res.status}): ${text || res.statusText}`);
  }

  const data = await res.json().catch(() => null);
  if (!data || typeof data !== 'object') {
    throw new Error('Unexpected response from GitHub.');
  }

  const latestTag = String(data.tag_name || data.name || '').trim();
  if (!latestTag) {
    throw new Error('Latest release has no version tag.');
  }

  const coercedCurrent = semver.coerce(stripLeadingV(current));
  const coercedLatest = semver.coerce(stripLeadingV(latestTag));
  let updateAvailable = false;
  let comparable = false;
  /** @type {'behind' | 'equal' | 'ahead' | null} */
  let relation = null;
  if (coercedCurrent && coercedLatest) {
    comparable = true;
    const cmp = semver.compare(coercedLatest, coercedCurrent);
    if (cmp > 0) {
      updateAvailable = true;
      relation = 'behind';
    } else if (cmp < 0) {
      relation = 'ahead';
    } else {
      relation = 'equal';
    }
  }

  return {
    current,
    latestTag,
    latestName: data.name != null ? String(data.name) : null,
    html_url: typeof data.html_url === 'string' ? data.html_url : null,
    updateAvailable,
    comparable,
    relation,
  };
}

module.exports = {
  checkTrackflowUpdate,
  readLocalPackageVersion,
  GITHUB_LATEST_RELEASE,
};
