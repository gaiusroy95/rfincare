function pickField(row, ...keys) {
  if (!row || typeof row !== "object") return void 0;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(row, key) && row[key] != null) {
      return row[key];
    }
  }
  const lowerMap = new Map(
    Object.keys(row).map((k) => [k.toLowerCase(), row[k]])
  );
  for (const key of keys) {
    if (lowerMap.has(String(key).toLowerCase())) {
      return lowerMap.get(String(key).toLowerCase());
    }
  }
  return void 0;
}
function mapHomepageNewsRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    excerpt: pickField(row, "excerpt") ?? null,
    blogUrl: pickField(row, "blogUrl", "blog_url") ?? null,
    imageUrl: pickField(row, "imageUrl", "image_url") ?? null,
    imageAlt: pickField(row, "imageAlt", "image_alt") ?? null,
    category: pickField(row, "category") ?? null,
    publishedAt: pickField(row, "publishedAt", "published_at") ?? null,
    isPublished: Boolean(
      pickField(row, "isPublished", "is_published") ?? true
    ),
    sortOrder: Number(pickField(row, "sortOrder", "sort_order") ?? 0),
    createdAt: pickField(row, "createdAt", "created_at") ?? null
  };
}
function mapHomepageVideoRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    description: pickField(row, "description") ?? null,
    youtubeUrl: pickField(row, "youtubeUrl", "youtube_url") ?? null,
    thumbnailUrl: pickField(row, "thumbnailUrl", "thumbnail_url") ?? null,
    thumbnailAlt: pickField(row, "thumbnailAlt", "thumbnail_alt") ?? null,
    durationLabel: pickField(row, "durationLabel", "duration_label") ?? null,
    isPublished: Boolean(
      pickField(row, "isPublished", "is_published") ?? true
    ),
    sortOrder: Number(pickField(row, "sortOrder", "sort_order") ?? 0)
  };
}
function mapSuccessStoryRow(row) {
  if (!row) return null;
  const rawType = String(
    pickField(row, "storyType", "story_type", "storytype") ?? "customer"
  ).toLowerCase();
  return {
    id: row.id,
    name: pickField(row, "name", "submitter_name", "submittername") ?? "",
    submitterName: pickField(row, "submitter_name", "submitterName", "name") ?? "",
    submitterEmail: pickField(row, "submitter_email", "submitterEmail") ?? null,
    submitterPhone: pickField(row, "submitter_phone", "submitterPhone") ?? null,
    storyType: rawType === "agent" ? "agent" : "customer",
    storyText: pickField(row, "storyText", "story_text", "storytext") ?? "",
    location: pickField(row, "location") ?? null,
    loanAmount: pickField(row, "loanAmount", "loan_amount", "loanamount") ?? null,
    photoUrl: pickField(row, "photoUrl", "photo_url", "photourl") ?? null,
    createdAt: pickField(row, "createdAt", "created_at", "createdat") ?? null,
    moderationStatus: pickField(row, "moderation_status", "moderationStatus") ?? null
  };
}
export {
  mapHomepageNewsRow,
  mapHomepageVideoRow,
  mapSuccessStoryRow,
  pickField
};
