/** The sample company created by `pnpm seed`. */
export const DEMO_EMAIL = "demo@softilo.test";
export const DEMO_PASSWORD = "softilo-demo-2026";
export const DEMO_COMPANY = "Thames Valley Imports Ltd";

/** The login page offers the demo in development, and in production only when DEMO_MODE=1. */
export const demoEnabled = () => process.env.DEMO_MODE === "1" || process.env.NODE_ENV !== "production";
