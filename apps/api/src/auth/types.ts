export type AuthenticatedUser = { id: string; email: string };

declare module 'express-session' {
  interface SessionData {
    userId?: string;
    csrfTokenHashes?: string[];
  }
}
