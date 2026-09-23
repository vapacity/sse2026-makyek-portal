import { argv } from 'yargs';
import gulp from 'gulp';
import sourcemaps from 'gulp-sourcemaps';
import nodemon from 'gulp-nodemon';
import plumber from 'gulp-plumber';
import babel from 'gulp-babel';
import eslint from 'gulp-eslint';
import Cache from 'gulp-file-cache';
import del from 'del';

const cache = new Cache();

gulp.task('clean', () => {
  return del(['.dist/**', '.gulp-cache']);
});

gulp.task('jd', () => {
  return gulp.src('./src/**/*.js')
    .pipe(plumber())
    .pipe(sourcemaps.init())
    .pipe(cache.filter())
    .pipe(eslint())
    .pipe(eslint.format())
    .pipe(babel())
    .pipe(cache.cache())
    .pipe(sourcemaps.write('.'))
    .pipe(gulp.dest('./.dist'));
});

gulp.task('jd:develop', ['jd'], () => {
  nodemon({
    script: '.dist/jd.js',
    args: ['--role', argv.role],
    watch: ['.'],
    ext: 'js yaml',
    ignore: ['node_modules/', '.dist/'],
    delay: 2000,
    tasks: ['jd'],
  });
});

gulp.task('default', ['jd:develop']);
