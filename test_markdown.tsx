import React from 'react';
import { renderToString } from 'react-dom/server';
import Markdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';

const html = renderToString(
  React.createElement(Markdown, { rehypePlugins: [rehypeRaw] }, '<span style="color: red;">Hello</span>')
);
console.log(html);
