import gulp from 'gulp';
import sourcemaps from 'gulp-sourcemaps';
import plumber from 'gulp-plumber';
import babel from 'gulp-babel';
import Cache from 'gulp-file-cache';
import del from 'del';

const cache = new Cache();

gulp.task('clean', () => {
  return del(['.dist/**', '.gulp-cache']);
});

gulp.task('js', () => {
  return gulp.src('./src/**/*.js')
    .pipe(plumber())
    .pipe(sourcemaps.init())
    .pipe(cache.filter())
    .pipe(babel())
    .pipe(cache.cache())
    .pipe(sourcemaps.write('.'))
    .pipe(gulp.dest('./.dist'));
});

gulp.task('default', ['js']);
