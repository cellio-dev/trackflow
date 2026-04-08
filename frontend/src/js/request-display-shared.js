/**
 * Requests UI: uses TrackFlowTrackStatus.computeDisplayFields with /api/settings.
 * Import track-status-shared before this script (see pages that use TrackFlowRequestDisplay).
 */
import './track-status-shared.js';

(function (global) {
  let availabilitySettings = {
    plex_integration_enabled: false,
  };

  function configureSettings(s) {
    if (!s || typeof s !== 'object') {
      return;
    }
    availabilitySettings = {
      plex_integration_enabled: Boolean(s.plex_integration_enabled),
    };
  }

  function computeDisplayFields(row) {
    return global.TrackFlowTrackStatus.computeDisplayFields(row, availabilitySettings);
  }

  global.TrackFlowRequestDisplay = { computeDisplayFields, configureSettings };
})(typeof window !== 'undefined' ? window : globalThis);
