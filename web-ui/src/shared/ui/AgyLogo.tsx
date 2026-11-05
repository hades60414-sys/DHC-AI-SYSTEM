type AgyLogoProps = {
  className?: string;
};

/** Rendered by the shared LLMProviderLogo when the provider is Google agy. */
const AgyLogo = ({ className = 'w-5 h-5' }: AgyLogoProps) => (
  <svg
    viewBox="0 0 24 24"
    role="img"
    aria-label="Google agy"
    className={className}
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path d="M12 2.5c.6 5.2 4.3 8.9 9.5 9.5-5.2.6-8.9 4.3-9.5 9.5-.6-5.2-4.3-8.9-9.5-9.5 5.2-.6 8.9-4.3 9.5-9.5Z" fill="#4285F4" />
    <path d="M12 7.5c.35 2.8 1.7 4.15 4.5 4.5-2.8.35-4.15 1.7-4.5 4.5-.35-2.8-1.7-4.15-4.5-4.5 2.8-.35 4.15-1.7 4.5-4.5Z" fill="#FBBC04" />
  </svg>
);

export default AgyLogo;
