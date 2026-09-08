import { createApp } from './app.ts';

const port = Number.parseInt(process.env.PORT || '3000', 10);

createApp().listen(port, () => {
  console.log(`listening on ${port}`);
});
