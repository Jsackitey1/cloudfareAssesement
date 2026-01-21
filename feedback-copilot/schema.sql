DROP TABLE IF EXISTS feedback;
CREATE TABLE feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  source TEXT,
  sentiment REAL,
  gravity_score INTEGER,
  category TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
