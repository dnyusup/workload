import { useState, type MouseEvent } from 'react';
import guideId from './guide.id.html?raw';
import guideEn from './guide.en.html?raw';

type GuideLanguage = 'id' | 'en';

// Static content shipped with the app (no user input), so rendering it as HTML is safe.
const GUIDE_HTML: Record<GuideLanguage, string> = { id: guideId, en: guideEn };

/** Guidance — the in-app user guide, in English and Bahasa Indonesia. Always opens in English. */
export function GuidancePage() {
  const [language, setLanguage] = useState<GuideLanguage>('en');

  // Contents links scroll within the page instead of changing the URL hash, which the host app owns.
  const followContentsLink = (e: MouseEvent<HTMLDivElement>) => {
    const link = (e.target as HTMLElement).closest('a[href^="#"]');
    if (!link) return;
    e.preventDefault();
    document.getElementById(link.getAttribute('href')!.slice(1))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className="guidance-page">
      <div className="guidance-toolbar">
        <div className="guidance-language" role="group" aria-label="Language / Bahasa">
          <button type="button" aria-pressed={language === 'en'} onClick={() => setLanguage('en')}>
            English
          </button>
          <button type="button" aria-pressed={language === 'id'} onClick={() => setLanguage('id')}>
            Bahasa Indonesia
          </button>
        </div>
      </div>
      <div
        className="guidance-layout"
        lang={language}
        onClick={followContentsLink}
        dangerouslySetInnerHTML={{ __html: GUIDE_HTML[language] }}
      />
    </div>
  );
}
