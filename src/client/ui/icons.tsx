import React from 'react';

const PATHS: Record<string, React.ReactNode> = {
  settings: (
    <>
      <circle cx="12" cy="12" r="3"/>
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
    </>
  ),
  grid: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1"/>
      <rect x="14" y="3" width="7" height="7" rx="1"/>
      <rect x="14" y="14" width="7" height="7" rx="1"/>
      <rect x="3" y="14" width="7" height="7" rx="1"/>
    </>
  ),
  popout: (
    <>
      <path d="M15 3h6v6"/>
      <path d="M10 14 21 3"/>
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
    </>
  ),
  dock: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2"/>
      <path d="M3 9h18"/>
    </>
  ),
  x: (
    <>
      <path d="M18 6 6 18"/>
      <path d="m6 6 12 12"/>
    </>
  ),
  check: <path d="M20 6 9 17l-5-5"/>,
  speaker: (
    <>
      <path d="M11 5 6 9H2v6h4l5 4z"/>
      <path d="M15.5 8.5a5 5 0 0 1 0 7"/>
      <path d="M19 5a10 10 0 0 1 0 14"/>
    </>
  ),
  'speaker-off': (
    <>
      <path d="M11 5 6 9H2v6h4l5 4z"/>
      <path d="m22 9-6 6"/>
      <path d="m16 9 6 6"/>
    </>
  ),
  heart: <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>,
  star: <path d="M11.5 2.5 14 8l6 .8-4.4 4.1 1.2 5.9-5.3-3-5.3 3 1.2-5.9L3 8.8 9 8z"/>,
  gift: (
    <>
      <rect x="3" y="8" width="18" height="4" rx="1"/>
      <path d="M12 8v13M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7"/>
      <path d="M7.5 8a2.5 2.5 0 0 1 0-5C11 3 12 8 12 8s1-5 4.5-5a2.5 2.5 0 0 1 0 5"/>
    </>
  ),
  bits: <path d="m13 2-9 11h7l-1 9 9-11h-7z"/>,
  chat: <path d="M21 12a8 8 0 0 1-8 8H7l-4 3v-4.5A8 8 0 0 1 5 5.6 8 8 0 0 1 13 4a8 8 0 0 1 8 8Z"/>,
  play: <path d="M5 5v14l14-7z"/>,
  edit: (
    <>
      <path d="M12 20h9"/>
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>
    </>
  ),
  users: (
    <>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>
      <circle cx="9" cy="7" r="4"/>
      <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>
    </>
  ),
  swords: (
    <>
      <path d="M14.5 17.5 3 6V3h3l11.5 11.5"/>
      <path d="m13 19 6-6M16 16l4 4M19 21l2-2"/>
      <path d="M14.5 6.5 18 3h3v3l-3.5 3.5"/>
      <path d="M5 14l-2 2 3 3 2-2"/>
    </>
  ),
  /* A broadcast mast: the broadcaster's role badge. */
  broadcast: (
    <>
      <circle cx="12" cy="12" r="2"/>
      <path d="M16.24 7.76a6 6 0 0 1 0 8.49M7.76 16.24a6 6 0 0 1 0-8.49"/>
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 19.07a10 10 0 0 1 0-14.14"/>
    </>
  ),
  'chevron-down': <path d="m6 9 6 6 6-6"/>,
  'arrow-up': <path d="M12 19V5M6 11l6-6 6 6"/>,
  'arrow-down': <path d="M12 5v14M6 13l6 6 6-6"/>,
  'arrow-right': <path d="M5 12h14M13 6l6 6-6 6"/>,
  /* The four alert glyphs from the overlay's alert cards (overlayText.tsx ToneIcon),
     so a follow, sub, raid or cheer reads the same on the dashboard as on stream. */
  sparkle: <path d="M12 3l2.2 5.8L20 11l-5.8 2.2L12 19l-2.2-5.8L4 11l5.8-2.2z"/>,
  planet: (
    <>
      <circle cx="12" cy="12" r="6"/>
      <ellipse cx="12" cy="12" rx="10" ry="3" transform="rotate(-22 12 12)"/>
    </>
  ),
  raid: (
    <>
      <path d="M4 20L20 4"/>
      <path d="M13 4h7v7"/>
      <path d="M4 12v8h8"/>
    </>
  ),
  gem: (
    <>
      <path d="M12 3l7 9-7 9-7-9z"/>
      <path d="M5 12h14"/>
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="10"/>
      <path d="M12 16v-4M12 8h.01"/>
    </>
  ),
  /* A warning: the same circle as `info`, with the mark turned upside down. */
  alert: (
    <>
      <circle cx="12" cy="12" r="10"/>
      <path d="M12 8v4M12 16h.01"/>
    </>
  ),
  refresh: (
    <>
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/>
      <path d="M21 3v5h-5"/>
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/>
      <path d="M8 16H3v5"/>
    </>
  ),
};

export type IconName = keyof typeof PATHS;

export function Icon({
  name,
  size = 16,
  ...rest
}: { name: string; size?: number } & Omit<React.SVGProps<SVGSVGElement>, 'name'>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...rest}
    >
      {PATHS[name] ?? null}
    </svg>
  );
}
