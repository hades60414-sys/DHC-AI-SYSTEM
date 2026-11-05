type ClaudeLogoProps = {
  className?: string;
};

/**
 * Rendered by the shared LLMProviderLogo when the provider is Claude. DHC CLI brand: the sidebar LogoBlock's
 * dog face on the primary tile stands in for the Claude logo.
 */
const ClaudeLogo = ({ className = 'w-5 h-5' }: ClaudeLogoProps) => (
  <svg viewBox="0 0 64 64" role="img" aria-label="New coworker" className={`text-primary ${className}`} fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect width="64" height="64" rx="14" fill="currentColor" opacity="0.9" />
    <g
      className="text-primary-foreground"
      transform="translate(-6.4 -9.6) scale(1.2)"
      stroke="currentColor"
      strokeWidth={2.4}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M20 30 Q20 19 32 19 Q44 19 44 30 Q44.5 46.5 32 47 Q19.5 46.5 20 30 Z" />
      <path d="M21.5 21.5 Q13 20 13.5 30 Q14 36 19.8 33.5" />
      <path d="M42.5 21.5 Q51 20 50.5 30 Q50 36 44.2 33.5" />
      <circle cx="26.5" cy="29" r="1.7" fill="currentColor" stroke="none" />
      <circle cx="37.5" cy="29" r="1.7" fill="currentColor" stroke="none" />
      <ellipse cx="32" cy="35.4" rx="2.7" ry="1.9" fill="currentColor" stroke="none" />
      <path d="M32 37.3 v2.4 M28 39.8 q2 2 4 0 q2 2 4 0" />
    </g>
  </svg>
);

export default ClaudeLogo;
