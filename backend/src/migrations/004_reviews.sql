-- Reviews ("testimony registry", reviews.html). Anonymous, free-text name —
-- not tied to a user account — so no author_id FK (unlike threads/comments).
CREATE TABLE reviews (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_reviews_created ON reviews(created_at DESC);
