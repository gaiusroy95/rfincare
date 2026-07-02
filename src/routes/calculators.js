import { Router } from 'express';
import { z } from 'zod';

import {
  CALCULATOR_CATEGORIES,
  getCalculatorBySlug,
  listCalculators,
  runCalculator,
} from '../lib/financialCalculators/index.js';

export const calculatorsRouter = Router();

calculatorsRouter.get('/', (_req, res) => {
  const category = _req.query?.category?.toString();
  res.json({
    categories: CALCULATOR_CATEGORIES,
    calculators: listCalculators({ category: category || undefined }),
    total: listCalculators().length,
  });
});

calculatorsRouter.get('/categories', (_req, res) => {
  res.json({ categories: CALCULATOR_CATEGORIES });
});

calculatorsRouter.get('/:slug', (req, res, next) => {
  try {
    const meta = getCalculatorBySlug(req.params.slug);
    if (!meta) {
      const e = new Error('Calculator not found');
      e.status = 404;
      throw e;
    }
    res.json({
      slug: meta.slug,
      title: meta.title,
      category: meta.category,
      description: meta.description,
      tags: meta.tags,
      engine: meta.engine,
      defaults: meta.defaults,
    });
  } catch (err) {
    next(err);
  }
});

const CalculateSchema = z.record(z.unknown());

calculatorsRouter.post('/:slug/calculate', (req, res, next) => {
  try {
    const input = CalculateSchema.parse(req.body || {});
    const output = runCalculator(req.params.slug, input);
    res.json(output);
  } catch (err) {
    next(err);
  }
});

// Batch calculate (for compare / dashboard widgets)
calculatorsRouter.post('/batch/calculate', (req, res, next) => {
  try {
    const body = z
      .object({
        items: z.array(
          z.object({
            slug: z.string(),
            input: z.record(z.unknown()).optional(),
          }),
        ),
      })
      .parse(req.body);
    const results = body.items.map(({ slug, input }) => {
      try {
        return { slug, ok: true, data: runCalculator(slug, input || {}) };
      } catch (err) {
        return { slug, ok: false, error: err.message };
      }
    });
    res.json({ results });
  } catch (err) {
    next(err);
  }
});
