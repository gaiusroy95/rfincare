import { getPool } from '../db/pool.js';
import { pickField } from './cmsContentMap.js';

const DEFAULT_ABOUT_CONTENT = {
  heroTitle: 'About Rfincare',
  heroSubtitle:
    'Empowering Indians with smart financial solutions through technology and transparency',
  stats: [
    { id: 'customers', value: '50,000+', label: 'Happy Customers' },
    { id: 'banks', value: '100+', label: 'Partner Banks' },
    { id: 'processed', value: '₹500Cr+', label: 'Loans Processed' },
    { id: 'satisfaction', value: '98%', label: 'Satisfaction Rate' },
  ],
  values: [
    {
      id: 'mission',
      icon: 'Target',
      title: 'Our Mission',
      description:
        'To simplify the loan application process and make financial services accessible to everyone across India.',
    },
    {
      id: 'vision',
      icon: 'Eye',
      title: 'Our Vision',
      description:
        "To become India's most trusted digital platform for loan comparison and application processing.",
    },
    {
      id: 'values',
      icon: 'Heart',
      title: 'Our Values',
      description:
        'Transparency, customer-first approach, innovation, and commitment to financial inclusion.',
    },
    {
      id: 'promise',
      icon: 'Shield',
      title: 'Our Promise',
      description:
        'Secure, fast, and reliable loan processing with complete transparency at every step.',
    },
  ],
  storyHeading: 'Our Story',
  storyParagraphs: [
    'Founded in 2020, Rfincare emerged from a simple observation: getting a loan in India was unnecessarily complicated. Multiple bank visits, endless paperwork, and lack of transparency made the process frustrating for millions.',
    'We set out to change this. By leveraging technology and building strong partnerships with leading financial institutions, we created a platform that puts customers first. Today, we help thousands of Indians find the right loan products, compare options transparently, and complete applications digitally.',
    'Our team of financial experts, technology professionals, and customer service specialists work tirelessly to ensure every customer gets personalized guidance and the best possible loan terms for their unique situation.',
  ],
};

function parseJson(value, fallback) {
  if (value == null || value === '') return fallback;
  if (Array.isArray(value)) return value;
  if (typeof value === 'object') {
    return Array.isArray(value) ? value : fallback;
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export async function getAboutPageContent() {
  const pool = getPool();
  const [[row]] = await pool.execute(
    `SELECT
       hero_title, hero_subtitle, stats_json, values_json, story_heading, story_paragraphs_json, updated_at
     FROM about_page_content
     WHERE id = 'default'
     LIMIT 1`,
  );
  if (!row) return { ...DEFAULT_ABOUT_CONTENT };

  return {
    heroTitle: pickField(row, 'hero_title', 'heroTitle') || DEFAULT_ABOUT_CONTENT.heroTitle,
    heroSubtitle: pickField(row, 'hero_subtitle', 'heroSubtitle') || DEFAULT_ABOUT_CONTENT.heroSubtitle,
    stats: parseJson(pickField(row, 'stats_json', 'statsJson'), DEFAULT_ABOUT_CONTENT.stats),
    values: parseJson(pickField(row, 'values_json', 'valuesJson'), DEFAULT_ABOUT_CONTENT.values),
    storyHeading: pickField(row, 'story_heading', 'storyHeading') || DEFAULT_ABOUT_CONTENT.storyHeading,
    storyParagraphs: parseJson(
      pickField(row, 'story_paragraphs_json', 'storyParagraphsJson'),
      DEFAULT_ABOUT_CONTENT.storyParagraphs,
    ),
    updatedAt: pickField(row, 'updated_at', 'updatedAt') ?? null,
  };
}

export async function upsertAboutPageContent(input, userId) {
  const pool = getPool();
  await pool.execute(
    `INSERT INTO about_page_content
      (id, hero_title, hero_subtitle, stats_json, values_json, story_heading, story_paragraphs_json, updated_by, updated_at)
     VALUES
      ('default', :hero_title, :hero_subtitle, :stats_json, :values_json, :story_heading, :story_paragraphs_json, :updated_by, NOW())
     ON CONFLICT (id) DO UPDATE SET
      hero_title = EXCLUDED.hero_title,
      hero_subtitle = EXCLUDED.hero_subtitle,
      stats_json = EXCLUDED.stats_json,
      values_json = EXCLUDED.values_json,
      story_heading = EXCLUDED.story_heading,
      story_paragraphs_json = EXCLUDED.story_paragraphs_json,
      updated_by = EXCLUDED.updated_by,
      updated_at = NOW()`,
    {
      hero_title: input.heroTitle,
      hero_subtitle: input.heroSubtitle || null,
      stats_json: JSON.stringify(input.stats || []),
      values_json: JSON.stringify(input.values || []),
      story_heading: input.storyHeading,
      story_paragraphs_json: JSON.stringify(input.storyParagraphs || []),
      updated_by: userId || null,
    },
  );
  return getAboutPageContent();
}
