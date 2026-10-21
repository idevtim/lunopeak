/**
 * Splash visibility is purely time-based, not data-dependent. The splash
 * dismisses on a fixed timer so the app reveal feels predictable; views
 * then render skeletons while data loads in the background.
 */
export const SPLASH_MIN_MS = 1800;
