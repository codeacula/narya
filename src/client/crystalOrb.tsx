import React from 'react';

export type CrystalOrbVariant = 'arcane' | 'moon';

/**
 * The Codeacula crystal orb: layered radial gradients, no image. `arcane` is the
 * bright blue mark used in the bottom bar; `moon` is the paler one the holding scenes
 * use. Sized by one custom property so every glow and inset scales with it.
 */
export function CrystalOrb({ variant = 'arcane', size = 22 }: { variant?: CrystalOrbVariant; size?: number }) {
  return (
    <div
      className={`crystal-orb crystal-orb--${variant}`}
      style={{ '--s': `${size}px` } as React.CSSProperties}
      aria-hidden="true"
    >
      <i className="crystal-orb-body" />
      <i className="crystal-orb-stars" />
      <i className="crystal-orb-ring-inner" />
      <i className="crystal-orb-rim" />
      <i className="crystal-orb-spec" />
      <i className="crystal-orb-spec-low" />
    </div>
  );
}
