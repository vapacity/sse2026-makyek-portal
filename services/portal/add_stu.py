import os
import argparse


def main(src_path):
	students = []
	with open(src_path, 'r') as f:
		for line in f:
			students.append(line.rstrip())
	for student in students:
		os.system('npm run cli -- DI.models.User.createUserAsync {} {} {} {} student'.format(student, student, student, student))


if __name__ == '__main__':
	parser = argparse.ArgumentParser(description='Add accounts for students using student number list.')
	parser.add_argument('src', type=str, help='path to student number list file.')
	args = parser.parse_args()
	main(args.src)
