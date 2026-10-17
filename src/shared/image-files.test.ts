import { describe, expect, it } from 'vitest';
import {
  imageContentType,
  imgTag,
  isImagePath,
  parseProjectImageUrl,
  projectImageUrl,
  relativeHref,
} from './image-files';

/** S52.6: image viewer paths, URLs and the HTML snippets "Copy <img> tag" / "Copy relative path" produce. */
const ID = '3f1c2a9e-8b7d-4c6e-9f00-1a2b3c4d5e6f';

describe('image files (S52.6)', () => {
  it('png, jpg, gif, svg, webp and ico open in the viewer; fonts and other binaries do not', () => {
    for (const p of ['a.png', '图片 素材/标志.JPG', 'x.jpeg', 'y.gif', 'icon.svg', 'p.webp', 'favicon.ico']) {
      expect(isImagePath(p)).toBe(true);
    }
    for (const p of ['font.woff2', 'font.ttf', 'a.pdf', 'archive.zip', 'png', '.png', 'index.html', '.git/a.png']) {
      expect(isImagePath(p)).toBe(false);
    }
    expect(imageContentType('icon.svg')).toBe('image/svg+xml');
    expect(imageContentType('a.JPG')).toBe('image/jpeg');
    expect(imageContentType('font.woff')).toBeNull();
  });

  it('the viewer URL round-trips Chinese names, spaces, # and ?', () => {
    const relPath = '图片 素材/标志 #1?.png';
    const url = projectImageUrl('noobide', ID, relPath, 1234);
    expect(url).toBe(
      `noobide://project/${ID}/${encodeURIComponent('图片 素材')}/${encodeURIComponent('标志 #1?.png')}?v=1234`,
    );
    expect(parseProjectImageUrl('noobide', url)).toEqual({ projectId: ID, relPath });
  });

  it('other hosts, schemes and malformed URLs are not image requests', () => {
    expect(parseProjectImageUrl('noobide', 'noobide://app/index.html')).toBeNull();
    expect(parseProjectImageUrl('noobide', `file:///project/${ID}/a.png`)).toBeNull();
    expect(parseProjectImageUrl('noobide', `noobide://project/${ID}`)).toBeNull();
    expect(parseProjectImageUrl('noobide', `noobide://project/${ID}/%E0%A4%A.png`)).toBeNull();
    // `..` is resolved by the URL parser itself, so it can never climb out of the project id segment either.
    expect(parseProjectImageUrl('noobide', `noobide://project/${ID}/../../etc/a.png`)).toEqual({
      projectId: 'etc',
      relPath: 'a.png',
    });
  });

  it('"Copy relative path" is relative to the active HTML file', () => {
    expect(relativeHref('index.html', '图片 素材/标志.png')).toBe('图片%20素材/标志.png');
    expect(relativeHref('pages/about.html', 'img/a.png')).toBe('../img/a.png');
    expect(relativeHref('pages/deep/x.html', 'pages/img/a.png')).toBe('../img/a.png');
    expect(relativeHref('pages/x.html', 'pages/a.png')).toBe('a.png');
    expect(relativeHref('a/b.html', 'a.png')).toBe('../a.png');
    expect(relativeHref('index.html', 'a#b.png')).toBe('a%23b.png');
  });

  it('"Copy <img> tag" gives a tag with the relative src and the name as alt text', () => {
    expect(imgTag('index.html', '图片 素材/标志 图.png')).toBe('<img src="图片%20素材/标志%20图.png" alt="标志 图">');
    expect(imgTag('pages/about.html', 'img/a"b.svg')).toBe('<img src="../img/a%22b.svg" alt="a&quot;b">');
  });
});
