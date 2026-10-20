import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({plugins:[react()],build:{outDir:process.env.GRID_BENCH_OUT||'.qa/grid-benchmark',rolldownOptions:{input:'scripts/fixtures/grid-scroll.html'}},server:{host:'127.0.0.1',port:1425,strictPort:true}});
