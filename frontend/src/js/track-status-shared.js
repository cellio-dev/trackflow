/**
 * Unified request/track status mapping.
 * User-facing labels (displayStatus): only USER_STATUSES.
 * Admin pipeline labels (processingStatus): only ADMIN_STATUSES.
 */
(function (global) {
  const USER_STATUSES = Object.freeze([
    'Requested',
    'Processing',
    'Needs Attention',
    'Available',
    'Canceled',
    'Denied',
    'Complete',
  ]);

  const ADMIN_STATUSES = Object.freeze([
    'Pending',
    'Queued',
    'Searching',
    'Downloading',
    'Queued Remotely',
    'Failed',
    'Complete',
    'Canceled',
    'Denied',
  ]);

  function resolveFileMatchForDisplay(row) {
    if (row.library_file_match === true || row.library_file_match === false) {
      return row.library_file_match;
    }
    return false;
  }

  function isUserFacingLibraryAvailable(row) {
    return Boolean(resolveFileMatchForDisplay(row));
  }

  /**
   * @param {object} row — request-like: status, cancelled, processing_phase, library_file_match?
   * @param {object} [availabilitySettings] — merged with defaults (same shape as TrackFlowRequestDisplay settings)
   * @returns {{ displayStatus: string, processingStatus: string }}
   */
  function computeDisplayFields(row, _availabilitySettings) {
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
      const libAvail = isUserFacingLibraryAvailable(row);
      if (libAvail || status === 'available') {
        return { displayStatus: 'Available', processingStatus: 'Complete' };
      }
      return { displayStatus: 'Complete', processingStatus: 'Complete' };
    }

    return { displayStatus: '', processingStatus: '' };
  }

  /** When only raw API requestStatus is present (no full row). */
  function userStatusFromRequestStatusOnly(raw) {
    if (raw == null || raw === '') {
      return null;
    }
    const key = String(raw).toLowerCase();
    const map = {
      pending: 'Requested',
      requested: 'Requested',
      processing: 'Processing',
      completed: 'Available',
      available: 'Available',
      failed: 'Needs Attention',
      denied: 'Denied',
    };
    return map[key] || null;
  }

  global.TrackFlowTrackStatus = {
    USER_STATUSES,
    ADMIN_STATUSES,
    computeDisplayFields,
    userStatusFromRequestStatusOnly,
  };
})(typeof window !== 'undefined' ? window : globalThis);
