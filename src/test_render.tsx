import React from 'react';
import { createRoot } from 'react-dom/client';
import Markdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';

const App = () => {
  return (
    <div id="test-container">
      <Markdown rehypePlugins={[rehypeRaw]}>
        {'<span style="color: red;">Hello Red</span> and <font color="blue">Hello Blue</font>'}
      </Markdown>
    </div>
  );
};

const container = document.getElementById('root');
const root = createRoot(container!);
root.render(<App />);
