const Apify = require('apify');

process.env.API_KEY = '3c7beec8-846d-4377-be03-71cae6145fdc';
const {
    getHotelIds,
    resolveInBatches,
    processHotel,
    getRequestListSources,
    getRestaurantIds,
    processRestaurant,
    getClient,
    randomDelay,
    validateInput,
} = require('./tools/general');

const {
    getLocationId,
    buildRestaurantUrl,
    buildHotelUrl,
} = require('./tools/api');

const { utils: { log } } = Apify;
let error = 0;
Apify.main(async () => {
    // Create and initialize an instance of the RequestList class that contains the start URL.
    const input = await Apify.getValue('INPUT');
    validateInput(input);
    const {
        locationFullName,
        includeRestaurants = true,
        includeHotels = true,
        includeReviews = true,
        lastReviewDate = '2010-01-01',
        hotelId,
        restaurantId,
        checkInDate,
    } = input;
    log.debug('Received input', input);
    global.INCLUDE_REVIEWS = includeReviews;
    global.LAST_REVIEW_DATE = lastReviewDate;
    global.CHECKIN_DATE = checkInDate;
    // const timeStamp = Date.now();
    let requestList;
    // let restaurants;
    // let hotels;
    const generalDataset = await Apify.openDataset();
    let locationId;
    if (locationFullName) {
        // restaurants = await Apify.openDataset(`restaurants-${timeStamp}`);
        // hotels = await Apify.openDataset(`hotels-${timeStamp}`);

        locationId = await getLocationId(locationFullName);
        log.info(`Processing locationId: ${locationId}`);
        requestList = new Apify.RequestList({
            sources: getRequestListSources(locationId, includeHotels, includeRestaurants),
        });
    }

    if (restaurantId) {
        log.debug(`Processing restaurant ${restaurantId}`);
        requestList = new Apify.RequestList({
            sources: [{ url: 'https://www.tripadvisor.com', userData: { restaurantId, restaurantDetail: true } }],
        });
    } else if (hotelId) {
        log.debug(`Processing hotel ${restaurantId}`);
        requestList = new Apify.RequestList({
            sources: [{ url: 'https://www.tripadvisor.com', userData: { hotelId, hotelDetail: true } }],
        });
    }

    await requestList.initialize();
    const requestQueue = await Apify.openRequestQueue();


    const crawler = new Apify.CheerioCrawler({
        requestList,
        requestQueue,
        useApifyProxy: input.proxyConfiguration ? input.proxyConfiguration.useApifyProxy : true,
        apifyProxyGroups: input.proxyConfiguration ? input.proxyConfiguration.apifyProxyGroups : undefined,
        apifyProxySession: Math.random().toString(10),
        handlePageFunction: async ({ request, $ }) => {
            let client;

            if (request.userData.initialHotel) {
                // Process initial hotelList url and add others with pagination to request queue
                log.info(`Processing initial step ${request.url}...`);
                const lastDataOffset = $('a.pageNum').last().attr('data-offset') || 0;
                log.info(`Processing hotels with last data offset: ${lastDataOffset}`);
                const promises = [];
                for (let i = 0; i <= lastDataOffset; i += 30) {
                    promises.push(() => requestQueue.addRequest({
                        url: buildHotelUrl(locationId, i.toString()),
                        userData: { hotelList: true },
                    }));
                    log.debug(`Adding location with ID: ${locationId} Offset: ${i.toString()}`);
                    await randomDelay();
                }
                await resolveInBatches(promises);
            } else if (request.userData.hotelList) {
                // Gets ids of hotels from hotelList -> gets data for given id and saves hotel to dataset
                try {
                    client = await getClient();
                    log.info('Processing hotel list ', request.url);
                    const hotelIds = getHotelIds($);
                    await resolveInBatches(hotelIds.map((id) => {
                        log.debug(`Processing hotel with ID: ${id}`);
                        return () => processHotel(id, client, generalDataset);
                    }));
                } catch (e) {
                    log.error('Hotel list error', e);
                }
            } else if (request.userData.initialRestaurant) {
                // Process initial restaurantList url and add others with pagination to request queue
                const promises = [];
                const maxOffset = $('.pageNum.taLnk').last().attr('data-offset') || 0;
                log.info(`Processing restaurants with last data offset: ${maxOffset}`);
                for (let i = 0; i <= maxOffset; i += 30) {
                    log.info(`Adding restaurants search page with offset: ${i} to list`);

                    promises.push(() => requestQueue.addRequest({
                        url: buildRestaurantUrl(locationId, i.toString()),
                        userData: { restaurantList: true },
                    }));
                }
                await randomDelay();
                await resolveInBatches(promises);
            } else if (request.userData.restaurantList) {
                // Gets ids of restaurants from restaurantList -> gets data for given id and saves restaurant to dataset
                log.info('Processing restaurant list ', request.url);
                client = await getClient();
                const restaurantIds = getRestaurantIds($);
                await resolveInBatches(restaurantIds.map((id) => {
                    log.debug(`Processing restaurant with ID: ${id}`);

                    return () => processRestaurant(id, client, generalDataset);
                }));
            } else if (request.userData.restaurantDetail) {
                // For API usage only gets restaurantId from input and sets OUTPUT.json to key-value store
                //  a.k.a. returns response with restaurant data
                const { restaurantId: id } = request.userData;
                log.info(`Processing single API request for restaurant with id: ${id}`);
                client = await getClient();
                await processRestaurant(restaurantId, client);
            } else if (request.userData.hotelDetail) {
                // For API usage only gets hotelId from input and sets OUTPUT.json to key-value store
                //  a.k.a. returns response with hotel data
                const { hotelId: id } = request.userData;
                log.info(`Processing single API request for hotel with id: ${id}`);
                client = await getClient();
                await processHotel(hotelId, client);
            }
        },
        handleFailedRequestFunction: async ({ request }) => {
            log.info(`Request ${request.url} failed too many times`);
            await Apify.setValue(`ERROR-${Date.now()}`, JSON.stringify(request), { contentType: 'application/json' });
            error += 1;
        },
    });

    // Run the crawler and wait for it to finish.
    await crawler.run();
    log.info(`Requests failed: ${error}`);

    log.info('Crawler finished.');
});
