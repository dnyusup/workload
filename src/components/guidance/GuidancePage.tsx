import { useState, type MouseEvent } from 'react';
import guideId from './guide.id.html?raw';
import guideEn from './guide.en.html?raw';

type GuideLanguage = 'id' | 'en';

const LANGUAGE_STORAGE_KEY = 'workload-guidance-language';
// Static content shipped with the app (no user input), so rendering it as HTML is safe.
const GUIDE_HTML: Record<GuideLanguage, string> = { id: guideId, en: guideEn };

function readLanguage(): GuideLanguage {
  try {
    return localStorage.getItem(LANGUAGE_STORAGE_KEY) === 'en' ? 'en' : 'id';
  } catch {
    return 'id';
  }
}

/** Guidance — the in-app user guide, in Bahasa Indonesia and English. */
export function GuidancePage() {
  const [language, setLanguage] = useState<GuideLanguage>(readLanguage);

  const changeLanguage = (next: GuideLanguage) => {
    setLanguage(next);
    try {
      localStorage.setItem(LANGUAGE_STORAGE_KEY, next);
    } catch {
      // The choice still applies for this session if browser storage is unavailable.
    }
  };

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
          <button type="button" aria-pressed={language === 'id'} onClick={() => changeLanguage('id')}>
            Bahasa Indonesia
          </button>
          <button type="button" aria-pressed={language === 'en'} onClick={() => changeLanguage('en')}>
            English
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
