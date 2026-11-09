/**
 * Splash visibility is purely time-based, not data-dependent. The splash
 * dismisses on a fixed timer so the app reveal feels predictable; views
 * then render skeletons while data loads in the background.
 */
export const SPLASH_MIN_MS = 1800;

/**
 * Splash length when the launch restored last-known numbers (see
 * lib/queryPersist). Home has something real to show, so the reveal is quick.
 */
export const SPLASH_WARM_MS = 500;
