export const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000';
// Single local API server — the Node process on :5000 is the only backend now.
export const LLM_API_URL = import.meta.env.VITE_LLM_API_URL || 'http://localhost:5000';
export const NODE_API_URL = import.meta.env.VITE_NODE_API_URL || 'http://localhost:5000';
