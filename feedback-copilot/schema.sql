DROP TABLE IF EXISTS feedback; 
CREATE TABLE feedback ( 
  id TEXT PRIMARY KEY, 
  source TEXT, 
  content TEXT, 
  sentiment REAL, 
  category TEXT, 
  explanation TEXT, 
  gravity_score REAL, 
  created_at TEXT,
  status TEXT DEFAULT 'open',
  closed_at TEXT
);
