// ccdt speaks the system's language: the tests read its Chinese, the catalogs' source language, wherever they run.
// Imported first, so that ccdt's modules, and the processes the tests start, find it set.
process.env.LC_ALL = 'zh_CN.UTF-8';
