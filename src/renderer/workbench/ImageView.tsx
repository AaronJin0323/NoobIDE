import { useEffect, useState } from 'react';
import { useI18n } from '../i18n/I18nProvider';
import { copyText } from '../ai/clipboard';
import { fill } from './file-op-messages';
import { formatBytes } from '../recovery/format';
import { imgTag, relativeHref } from '../../shared/image-files';
import { WarningIcon } from './icons';

interface ImageViewProps {
  relPath: string;
  /** The image on the app protocol's `project` host (never the preview server). */
  url: string;
  bytes: number;
  /** The HTML file the snippets are relative to: the last HTML tab the user had open, or null. */
  htmlRelPath: string | null;
}

/**
 * S52.6: the image viewer tab. The picture is an `<img>` (an SVG shown this way never runs scripts), with its pixel
 * size and byte size as text, and two buttons that copy what a beginner needs to use it in a page: an `<img>` tag
 * and the relative path, both relative to the HTML file they last worked on.
 */
export function ImageView({ relPath, url, bytes, htmlRelPath }: ImageViewProps) {
  const { t } = useI18n();
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    setSize(null);
    setFailed(false);
    setCopied(null);
  }, [url]);

  const from = htmlRelPath ?? 'index.html';
  const copy = async (what: 'tag' | 'path') => {
    const text = what === 'tag' ? imgTag(from, relPath) : relativeHref(from, relPath);
    const ok = await copyText(text);
    setCopied(ok ? fill(t('image.copied'), { text }) : t('image.copyFailed'));
  };

  const name = relPath.slice(relPath.lastIndexOf('/') + 1);
  return (
    <section className="image-view" aria-label={fill(t('image.label'), { name })} data-testid="image-view">
      <div className="image-toolbar">
        <p className="image-facts" data-testid="image-facts">
          {size ? fill(t('image.dimensions'), { width: String(size.width), height: String(size.height) }) : ''}
          {size ? ' · ' : ''}
          {formatBytes(bytes)}
        </p>
        <button type="button" className="quiet-button" data-testid="image-copy-tag" onClick={() => void copy('tag')}>
          {t('image.copyTag')}
        </button>
        <button type="button" className="quiet-button" data-testid="image-copy-path" onClick={() => void copy('path')}>
          {t('image.copyPath')}
        </button>
      </div>
      <p className="dialog-hint">
        {htmlRelPath ? fill(t('image.relativeTo'), { file: htmlRelPath }) : t('image.relativeToDefault')}
      </p>
      <p className="dialog-hint" role="status" aria-live="polite" data-testid="image-copy-status">
        {copied ?? ''}
      </p>
      <div className="image-stage">
        {failed ? (
          <p className="inline-alert" role="alert">
            <WarningIcon />
            {t('image.failed')}
          </p>
        ) : (
          <img
            src={url}
            alt={name}
            data-testid="image-preview"
            onLoad={(event) =>
              setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })
            }
            onError={() => setFailed(true)}
          />
        )}
      </div>
    </section>
  );
}
