declare global {
  interface Window {
    /**
     * Navigate to the auth page with a custom redirect URL
     * @param redirectUrl - URL to redirect to after successful authentication
     */
    navigateToAuth: (redirectUrl: string) => void;

    /** Google reCAPTCHA Enterprise — dipakai untuk create-chat arena.ai. */
    grecaptcha?: {
      enterprise?: {
        ready?: (callback: () => void) => void;
        execute?: (siteKey: string, options: { action: string }) => Promise<string>;
      };
    };
  }
}

export {};