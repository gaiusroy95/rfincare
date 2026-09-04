import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  mapHomepageNewsRow,
  mapHomepageVideoRow,
  mapSuccessStoryRow,
} from '../../src/lib/cmsContentMap.js';

describe('cms content row mapping', () => {
  it('maps snake_case news rows to camelCase for the homepage', () => {
    const mapped = mapHomepageNewsRow({
      id: '1',
      title: 'Hello',
      excerpt: 'Ex',
      blog_url: 'https://example.com',
      image_url: 'https://cdn/x.jpg',
      image_alt: 'alt',
      category: 'news',
      published_at: '2026-01-01',
      is_published: true,
      sort_order: 2,
    });
    assert.equal(mapped.blogUrl, 'https://example.com');
    assert.equal(mapped.imageUrl, 'https://cdn/x.jpg');
    assert.equal(mapped.isPublished, true);
  });

  it('maps lowercase postgres aliases for success stories', () => {
    const mapped = mapSuccessStoryRow({
      id: 's1',
      submitter_name: 'Asha',
      storytype: 'customer',
      storytext: 'Great experience',
      loanamount: '25L',
      photourl: '/uploads/a.jpg',
      createdat: '2026-01-02',
    });
    assert.equal(mapped.name, 'Asha');
    assert.equal(mapped.storyType, 'customer');
    assert.equal(mapped.storyText, 'Great experience');
    assert.equal(mapped.loanAmount, '25L');
    assert.equal(mapped.photoUrl, '/uploads/a.jpg');
  });

  it('maps video youtube fields from snake_case', () => {
    const mapped = mapHomepageVideoRow({
      id: 'v1',
      title: 'EMI tips',
      youtube_url: 'https://youtu.be/abcdefghijk',
      is_published: true,
    });
    assert.equal(mapped.youtubeUrl, 'https://youtu.be/abcdefghijk');
  });
});
