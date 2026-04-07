/**
 * User-facing status labels for requests (Discover vs Requests page).
 * Availability follows library file matching + optional Plex (see libraryAvailability.isUserFacingLibraryAvailable).
 */

const { getDb } = require('../db');
const {
  isUserFacingLibraryAvailable,
  getAvailabilitySettingsSync,
  isPlexAvailabilityActive,
} = require('./libraryAvailability');

const db = getDb();

const setProcessingPhaseStmt = db.prepare(`
  UPDATE requests
  SET processing_phase = ?
  WHERE id = ?
`);

const clearProcessingPhaseStmt = db.prepare(`
  UPDATE requests
  SET processing_phase = NULL
  WHERE id = ?
`);

/**
 * @param {object} row — request row with status, cancelled, plex_status, processing_phase, library_file_match?
 * @returns {{ displayStatus: string, processingStatus: string }}
 */
function computeDisplayFields(row) {
  if (!row || typeof row !== 'object') {
    return { displayStatus: '', processingStatus: '' };
  }

  const status = String(row.status || '');
  const cancelled = Number(row.cancelled) === 1;
  const phase = row.processing_phase != null ? String(row.processing_phase) : '';

  if (status === 'denied') {
    return { displayStatus: 'Denied', processingStatus: 'Denied' };
  }

  if (status === 'pending' || status === 'requested') {
    return { displayStatus: 'Requested', processingStatus: 'Pending' };
  }

  if (status === 'failed' && cancelled) {
    return { displayStatus: 'Canceled', processingStatus: 'Canceled' };
  }

  if (status === 'failed' && !cancelled) {
    return { displayStatus: 'Needs Attention', processingStatus: 'Failed' };
  }

  if (status === 'processing' && cancelled) {
    return { displayStatus: 'Canceled', processingStatus: 'Canceled' };
  }

  if (status === 'processing' && !cancelled) {
    const phaseToAdmin = {
      queued: 'Queued',
      queued_remotely: 'Queued Remotely',
      searching: 'Searching',
      downloading: 'Downloading',
      moved: 'Downloading',
    };
    const processingStatus = phaseToAdmin[phase] || 'Downloading';
    return { displayStatus: 'Processing', processingStatus };
  }

  if (status === 'completed' || status === 'available') {
    const s = getAvailabilitySettingsSync();
    const plexOn = isPlexAvailabilityActive(s);
    const plexFound =
      row.library_plex_available === true || String(row.plex_status || '') === 'found';
    const libAvail = isUserFacingLibraryAvailable(row);

    if (libAvail || status === 'available') {
      return { displayStatus: 'Available', processingStatus: 'Complete' };
    }

    if (plexOn && !plexFound) {
      return { displayStatus: 'Processing', processingStatus: 'Plex Pending' };
    }

    return { displayStatus: 'Available', processingStatus: 'Complete' };
  }

  return { displayStatus: '', processingStatus: '' };
}

/**
 * Attach displayStatus + processingStatus for API clients. Keeps raw fields.
 */
function enrichRequestRow(row) {
  if (!row) {
    return row;
  }
  const { displayStatus, processingStatus } = computeDisplayFields(row);
  return {
    ...row,
    displayStatus,
    processingStatus,
  };
}

function setProcessingPhase(requestId, phase) {
  const id = Number(requestId);
  if (!Number.isInteger(id) || id <= 0 || phase == null) {
    return;
  }
  setProcessingPhaseStmt.run(String(phase), id);
}

function clearProcessingPhase(requestId) {
  const id = Number(requestId);
  if (!Number.isInteger(id) || id <= 0) {
    return;
  }
  clearProcessingPhaseStmt.run(id);
}

module.exports = {
  computeDisplayFields,
  enrichRequestRow,
  setProcessingPhase,
  clearProcessingPhase,
};
