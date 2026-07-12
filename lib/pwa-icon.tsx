import { ImageResponse } from 'next/og';

export const PWA_THEME_COLOR = '#10b981';
export const PWA_BACKGROUND_COLOR = '#ffffff';

export function EstimateAceIconMarkup() {
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: `linear-gradient(135deg, ${PWA_THEME_COLOR} 0%, #059669 100%)`,
        borderRadius: '22%',
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#ffffff',
          fontSize: '34%',
          fontWeight: 800,
          letterSpacing: '-0.04em',
          lineHeight: 1,
        }}
      >
        <div>EA</div>
        <div style={{ fontSize: '24%', fontWeight: 700, marginTop: '8%', opacity: 0.95 }}>
          Estimate
        </div>
      </div>
    </div>
  );
}

export function renderEstimateAceIcon(size: number) {
  return new ImageResponse(<EstimateAceIconMarkup />, {
    width: size,
    height: size,
  });
}