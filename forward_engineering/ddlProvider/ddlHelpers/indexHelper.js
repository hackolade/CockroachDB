module.exports = ({ _, wrapInQuotes, checkAllKeysDeactivated, getColumnsList }) => {
	const mapIndexKey = ({ name, sortOrder, nullsOrder, opclass }) => {
		const sortOrderStr = sortOrder ? ` ${sortOrder}` : '';
		const nullsOrderStr = nullsOrder ? ` ${nullsOrder}` : '';
		const opclassStr = opclass ? ` ${opclass}` : '';

		return `${wrapInQuotes(name)}${opclassStr}${sortOrderStr}${nullsOrderStr}`;
	};

	const getIndexKeys = (columns = [], isParentActivated) => {
		const isAllColumnsDeactivated = checkAllKeysDeactivated(columns);

		return getColumnsList(columns, isAllColumnsDeactivated, isParentActivated, mapIndexKey);
	};

	const getIndexOptions = (index, isParentActivated) => {
		const includeKeys = getColumnsList(
			index.include || [],
			checkAllKeysDeactivated(index.include || []),
			isParentActivated,
		);
		const indexesThatSupportHashing = ['btree'];

		const usingHash = index.using_hash && indexesThatSupportHashing.includes(index.index_method) ? ' USING HASH' : '';
		const include = index.include?.length ? ` INCLUDE ${_.trim(includeKeys)}` : '';
		const withOptionsString = getWithOptions(index);
		const withOptions = withOptionsString ? ` WITH (\n\t${withOptionsString})` : '';
		const whereExpression = index.where ? ` WHERE ${index.where}` : '';
		const visibility = index.visibility ? ` ${index.visibility}` : '';

		return _.compact([' ', usingHash, include, withOptions, whereExpression, visibility]).join('\n');
	};

	const getWithOptions = index => {
		const keysToOmit = ['id'];

		return _.chain(index.index_storage_parameter)
			.toPairs()
			.map(([key, value]) => {
				if (keysToOmit.includes(key) || _.isNil(value) || value === '') {
					return;
				}

				return `${key}=${getValue(value)}`;
			})
			.compact()
			.join(',\n\t')
			.value();
	};

	const getValue = value => {
		if (_.isBoolean(value)) {
			return value ? 'ON' : 'OFF';
		}

		return value;
	};

	return {
		getIndexKeys,
		getIndexOptions,
	};
};
